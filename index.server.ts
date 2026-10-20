import { dirname, join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listStatuses, refreshAll, refreshStatus, type SilentAgent } from "./shared/status";
import { AgentDirectory, pickCaller } from "./server/agents";
import { installBridge } from "./server/bridge";
import { Equipped } from "./server/equipped";
import { listen } from "./server/listener";
import { dataDir } from "./server/paths";
import { isStatusPermission } from "./server/permissions";
import { INSTRUCTIONS, readWaiting, StatusService, TOOLS, workspacesOf, type Courier } from "./server/service";
import { StatusStore } from "./server/store";

export default function contribute(server: PluginServerContext) {
  const dir = dataDir();
  // Sibling plugin's data, read for the "waiting on you" lines when it is installed.
  const asksDir = join(dirname(dir), "asks");
  const mcp = installBridge(dir);
  // The daemon session behind `paseo` lives as long as this subprocess; any hook or handler hands it over.
  let paseo: PaseoApi | null = null;
  const capture = (api: PaseoApi) => {
    paseo ??= api;
  };
  const requirePaseo = () => {
    if (!paseo) throw new Error("No daemon session yet");
    return paseo;
  };

  const agents = new AgentDirectory(dir, async (agentId) => {
    const handle = requirePaseo().agents.ref(agentId);
    await handle.refresh();
    return handle.workspaceId;
  });
  const callerIn = async (cwd: string) => {
    // The caller is mid-turn during its own tool call; background workspaces are left out unless asked for.
    const { entries } = await requirePaseo().agents.list({
      includeBackground: true,
      filter: { statuses: ["running"], includeBackground: true },
      page: { limit: 200 },
    });
    return pickCaller(entries.map((entry) => entry.agent), cwd);
  };
  const store = new StatusStore(dir);
  const courier: Courier = {
    async state(agentId) {
      const handle = requirePaseo().agents.ref(agentId);
      const found = await handle.refresh();
      if (!found || handle.archivedAt) return "gone";
      return handle.status === "running" || handle.status === "initializing" ? "running" : "idle";
    },
    async send(agentId, text) {
      await requirePaseo().agents.ref(agentId).send(text, { activeTurnBehavior: "steer" });
    },
  };
  const equipped = new Equipped(dir);
  const service = new StatusService(store, courier, (agentId) => agents.workspaceOf(agentId), (agentId) => equipped.has(agentId));

  type AgentPayload = Awaited<ReturnType<PaseoApi["agents"]["list"]>>["entries"][number]["agent"];
  /** Live agents in a workspace that have never published a status. */
  const silentAgents = (live: AgentPayload[], workspaceId: string): SilentAgent[] =>
    live
      .filter((agent) => agent.workspaceId === workspaceId && !store.get(agent.id))
      .map((agent) => ({ agentId: agent.id, title: agent.title ?? null }));
  const liveAgents = async (api: PaseoApi): Promise<AgentPayload[]> =>
    (await api.agents.list()).entries.map(({ agent }) => agent).filter((agent) => !agent.archivedAt && !agent.internal);

  server.before("agent.create", ({ request }, { paseo: api }) => {
    capture(api);
    return { ...request, config: { ...request.config, mcpServers: { ...request.config.mcpServers, status: mcp } } };
  });
  server.before("agent.session_open", ({ request }, { paseo: api }) => {
    capture(api);
    if (request.workspaceId) agents.remember(request.agentId, request.workspaceId);
  });
  server.on("agent.created", ({ agent }, { paseo: api }) => {
    capture(api);
    equipped.add(agent.id);
    if (agent.workspaceId) agents.remember(agent.id, agent.workspaceId);
  });
  server.on("agent.turn_ended", ({ agent, timeline }, { paseo: api }) => {
    capture(api);
    void service.turnEnded(agent.id, timeline).catch((error) => console.error("[status] turn bookkeeping failed", error));
  });
  // Plan mode and Codex prompt even for preapproved MCP tools. status_set only writes this plugin's card.
  server.on("agent.permission_requested", async ({ agent, request }, { paseo: api }) => {
    capture(api);
    if (!isStatusPermission(request)) return;
    await api.agents.ref(agent.id).respondToPermission({ requestId: request.id, response: { behavior: "allow" } });
  });
  server.on("agent.archived", ({ agent }, { paseo: api }) => {
    capture(api);
    store.patch(agent.id, { archived: true });
  });

  server.handle(listStatuses, async ({ workspaceId }, { paseo: api }) => {
    capture(api);
    const statuses = store.list(workspaceId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const live = await liveAgents(api);
    const agents = Object.fromEntries(
      live.map((agent) => [agent.id, { title: agent.title ?? null, running: agent.status === "running" || agent.status === "initializing" }]),
    );
    const workspaces = workspaceId
      ? {}
      : Object.fromEntries((await api.workspaces.list()).entries.map((workspace) => [workspace.id, workspace.title || workspace.name]));
    const silent = workspaceId ? silentAgents(live, workspaceId) : [];
    return { statuses, waiting: readWaiting(asksDir, workspacesOf(statuses)), silent, agents, workspaces };
  });
  server.handle(refreshAll, async ({ workspaceId, auto }, { paseo: api }) => {
    capture(api);
    const silent = workspaceId && !auto ? silentAgents(await liveAgents(api), workspaceId).map((agent) => agent.agentId) : [];
    return service.refreshAll(workspaceId, { auto, silent });
  });
  server.handle(refreshStatus, ({ agentId }, { paseo: api }) => {
    capture(api);
    return service.refresh(agentId);
  });

  const listening = listen(dir, {
    "/instructions": async () => ({ instructions: INSTRUCTIONS }),
    "/tools": async () => ({ tools: TOOLS }),
    "/call": async ({ agentId, cwd, name, arguments: args }) => service.callTool(agentId ?? (cwd ? await callerIn(cwd) : null), name, args),
    // The same Refresh the UI does, for scripts and terminal use.
    "/refresh": async (input) => service.refresh(refreshStatus.input.parse(input).agentId),
  });

  return async () => {
    (await listening).close();
  };
}
