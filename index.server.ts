import { dirname, join } from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listStatuses, refreshStatus } from "./shared/status";
import { AgentDirectory } from "./server/agents";
import { installBridge } from "./server/bridge";
import { listen } from "./server/listener";
import { dataDir } from "./server/paths";
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
  const service = new StatusService(store, courier, (agentId) => agents.workspaceOf(agentId));

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
    if (agent.workspaceId) agents.remember(agent.id, agent.workspaceId);
  });
  server.on("agent.turn_ended", ({ agent }, { paseo: api }) => {
    capture(api);
    void service.turnEnded(agent.id).catch((error) => console.error("[status] turn bookkeeping failed", error));
  });
  // Plan mode prompts even for preapproved MCP tools. status_set only writes this plugin's card.
  server.on("agent.permission_requested", async ({ agent, request }, { paseo: api }) => {
    capture(api);
    if (request.kind !== "tool" || !request.name.startsWith("mcp__status__")) return;
    await api.agents.ref(agent.id).respondToPermission({ requestId: request.id, response: { behavior: "allow" } });
  });
  server.on("agent.archived", ({ agent }, { paseo: api }) => {
    capture(api);
    store.patch(agent.id, { archived: true });
  });

  server.handle(listStatuses, ({ workspaceId }, { paseo: api }) => {
    capture(api);
    const statuses = store.list(workspaceId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { statuses, waiting: readWaiting(asksDir, workspacesOf(statuses)) };
  });
  server.handle(refreshStatus, ({ agentId }, { paseo: api }) => {
    capture(api);
    return service.refresh(agentId);
  });

  const listening = listen(dir, {
    "/instructions": async () => ({ instructions: INSTRUCTIONS }),
    "/tools": async () => ({ tools: TOOLS }),
    "/call": async ({ agentId, name, arguments: args }) => service.callTool(agentId ?? null, name, args),
    // The same Refresh the UI does, for scripts and terminal use.
    "/refresh": async (input) => service.refresh(refreshStatus.input.parse(input).agentId),
  });

  return async () => {
    (await listening).close();
  };
}
