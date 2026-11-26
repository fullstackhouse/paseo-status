import type { PaseoApi } from "@getpaseo/client";
import { latestTurn, type PluginServerContext } from "@getpaseo/plugin/server";
import { answersCard, type Backing, runsReply, turnPrompt, listStatuses, needsYouSince, type BlockerView, type Status, refreshAll, refreshStatus, syncAsks, type SilentAgent } from "./shared/status";
import { AgentDirectory, pickCaller } from "./server/agents";
import { BlockerResolver, ghPullRequest, type AgentFacts } from "./server/blockers";
import { installBridge } from "./server/bridge";
import { Equipped } from "./server/equipped";
import { listen } from "./server/listener";
import { hasBackgroundWork, Liveness, PARENT_AGENT_ID_LABEL, type LiveAgent } from "./server/liveness";
import { dataDir } from "./server/paths";
import { isStatusPermission } from "./server/permissions";
import { StatusService, type Courier } from "./server/service";
import { reportNeedsYou, snoozedWorkspaces } from "./server/snooze";
import { StatusStore } from "./server/store";

export default function contribute(server: PluginServerContext) {
  const dir = dataDir();
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
      if (handle.status !== "running" && handle.status !== "initializing") return "idle";
      // COMPAT(supportsSteering): hosts before fullstackhouse/paseo#115 omit it; those wait for the turn to end.
      return handle.capabilities?.supportsSteering ? "steerable" : "running";
    },
    async send(agentId, text) {
      await requirePaseo().agents.ref(agentId).send(text, { activeTurnBehavior: "steer" });
    },
  };
  const equipped = new Equipped(dir);
  const isBackground = async (workspaceId: string) =>
    (await requirePaseo().workspaces.ref(workspaceId).refresh())?.background === true;
  const isHelper = async (agentId: string) => !!(await requirePaseo().agents.ref(agentId).refresh())?.agent.labels?.[PARENT_AGENT_ID_LABEL];
  const service = new StatusService(
    store,
    courier,
    (agentId) => agents.workspaceOf(agentId),
    (agentId) => equipped.has(agentId),
    undefined,
    isBackground,
    isHelper,
  );

  type AgentPayload = Awaited<ReturnType<PaseoApi["agents"]["list"]>>["entries"][number]["agent"];
  /** Agents another agent started: the agent that started them reports status, so their cards from before stay hidden. */
  const helpersAmong = (agents: readonly { id: string; parentAgentId: string | null }[]) =>
    new Set(agents.filter((agent) => agent.parentAgentId).map((agent) => agent.id));
  const parentOf = (agent: AgentPayload) => agent.labels?.[PARENT_AGENT_ID_LABEL] ?? null;
  const visibleCards = (helpers: ReadonlySet<string>, workspaceId?: string) =>
    store.list(workspaceId).filter((status) => !helpers.has(status.agentId));
  /** Live agents in a workspace that have never published a status. */
  const silentAgents = (live: AgentPayload[], workspaceId: string): SilentAgent[] =>
    live
      .filter((agent) => agent.workspaceId === workspaceId && !parentOf(agent) && !store.get(agent.id))
      .map((agent) => ({ agentId: agent.id, title: agent.title ?? null }));
  const isRunning = (agent: AgentPayload) => agent.status === "running" || agent.status === "initializing";
  const liveAgents = async (api: PaseoApi): Promise<AgentPayload[]> =>
    (await api.agents.list()).entries.map(({ agent }) => agent).filter((agent) => !agent.archivedAt && !agent.internal);

  const blockerResolver = new BlockerResolver({
    pullRequest: ghPullRequest,
    agents: async () => {
      const api = requirePaseo();
      const found: AgentFacts[] = [];
      let cursor: string | undefined;
      do {
        const { entries, pageInfo } = await api.agents.list({ includeBackground: true, filter: { includeBackground: true }, page: { limit: 200, cursor } });
        for (const { agent } of entries) {
          if (!agent.archivedAt) found.push({ id: agent.id, title: agent.title ?? null, workspaceId: agent.workspaceId ?? null, status: agent.status });
        }
        cursor = pageInfo.hasMore ? (pageInfo.nextCursor ?? undefined) : undefined;
      } while (cursor);
      return found;
    },
    workspace: async (id) => {
      const workspace = await requirePaseo().workspaces.ref(id).refresh();
      return workspace ? { id: workspace.id, title: workspace.title || workspace.name || null } : null;
    },
  });
  /** What each blocked card waits on, resolved for display; cards in other states show none. */
  const resolveBlockers = async (statuses: readonly Status[]): Promise<Record<string, BlockerView[]>> => {
    const blocked = statuses.filter((status) => status.state === "blocked" && status.blockedBy?.length);
    const resolved = await Promise.all(blocked.map(async (status) => [status.agentId, await blockerResolver.resolve(status.blockedBy!)] as const));
    return Object.fromEntries(resolved);
  };

  /** Every non-archived agent on the host, background workspaces included: any can be a descendant. */
  const everyAgent = async (api: PaseoApi): Promise<LiveAgent[]> => {
    const busyWorkspaces = new Set<string>();
    let page: string | undefined;
    do {
      const { entries, pageInfo } = await api.workspaces.list({ includeBackground: true, page: { limit: 200, cursor: page } });
      for (const workspace of entries) if (workspace.status === "running") busyWorkspaces.add(workspace.id);
      page = pageInfo.hasMore ? (pageInfo.nextCursor ?? undefined) : undefined;
    } while (page);
    const found: LiveAgent[] = [];
    let cursor: string | undefined;
    do {
      const { entries, pageInfo } = await api.agents.list({
        includeBackground: true,
        filter: { includeBackground: true },
        page: { limit: 200, cursor },
      });
      for (const { agent } of entries) {
        if (agent.archivedAt) continue;
        found.push({
          id: agent.id,
          running: isRunning(agent),
          parentAgentId: parentOf(agent),
          workspaceId: agent.workspaceId ?? null,
          workspaceBusy: !!agent.workspaceId && busyWorkspaces.has(agent.workspaceId),
        });
      }
      cursor = pageInfo.hasMore ? (pageInfo.nextCursor ?? undefined) : undefined;
    } while (cursor);
    return found;
  };
  const liveness = new Liveness(
    (agentId) => hasBackgroundWork(requirePaseo().agents.ref(agentId)),
    undefined,
    (agentId) => void service.wake(agentId).catch((error) => console.error(`[status] could not wake ${agentId}`, error)),
  );
  let wakeTimer: ReturnType<typeof setTimeout> | undefined;
  /** What backs each shown card now (sending the wake-ups that fell due), and arms a timer for the next one. */
  const assess = async (api: PaseoApi) => {
    let cards: Status[] = [];
    const { backing } = await liveness.assess(async () => {
      const agents = await everyAgent(api);
      cards = visibleCards(helpersAmong(agents));
      return { agents, statuses: cards };
    });
    const due = liveness.nextWakeAt();
    if (due !== undefined && !wakeTimer) {
      wakeTimer = setTimeout(() => {
        wakeTimer = undefined;
        void assess(api).catch((error) => console.error("[status] wake check failed", error));
      }, Math.max(0, due - Date.now()) + 1000);
    }
    return { backing, cards };
  };
  /** What backs each shown card now, for Paseo's workspace attention; Paseo decides what it means. */
  const backingOf = async (api: PaseoApi): Promise<Record<string, Backing>> => {
    const { backing, cards } = await assess(api);
    return Object.fromEntries(cards.flatMap((card) => (backing.has(card.agentId) ? [[card.agentId, withPluginTurn(card.agentId, backing.get(card.agentId)!)] as const] : [])));
  };

  /**
   * Reports snoozed workspaces whose work came back to the human after the snooze began: a card
   * turned waiting or done. The host decides, from its snoozed-workspace setting, whether that wakes them.
   */
  const reportSnoozedNeedingYou = async (api: PaseoApi) => {
    const snoozed = await snoozedWorkspaces(api);
    if (snoozed.length === 0) return;
    const { backing, cards } = await assess(api);
    const running = (agentId: string) => runsReply(withPluginTurn(agentId, backing.get(agentId) ?? { running: false, live: false }));
    for (const workspace of snoozed) {
      const agentId = needsYouSince(
        cards.filter((card) => card.workspaceId === workspace.id),
        workspace.snoozedAt,
        running,
      );
      if (agentId && (await reportNeedsYou(api, workspace.id, agentId))) {
        console.log(`[status] woke snoozed workspace ${workspace.id}: it needs you`);
      }
    }
  };
  const afterStatusChange = (api: PaseoApi) =>
    void reportSnoozedNeedingYou(api).catch((error) => console.error("[status] could not report snoozed workspaces", error));

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
  // Turns a plugin's own prompt started (an Asks check, a reminder, a Refresh): they answer no card while they run.
  const pluginTurns = new Set<string>();
  const withPluginTurn = <T extends { running: boolean }>(agentId: string, agent: T): T =>
    agent.running && pluginTurns.has(agentId) ? { ...agent, pluginTurn: true } : agent;
  server.on("agent.turn_started", ({ agent }, { paseo: api }) => {
    capture(api);
    void latestTurn(api.agents.ref(agent.id).timeline)
      .then((turn) => {
        if (answersCard(turnPrompt(turn))) pluginTurns.delete(agent.id);
        else pluginTurns.add(agent.id);
      })
      .catch((error) => console.error("[status] could not read the turn's prompt", error));
  });
  server.on("agent.turn_ended", ({ agent }, { paseo: api }) => {
    capture(api);
    pluginTurns.delete(agent.id);
    liveness.turnEnded(agent.id);
    void latestTurn(api.agents.ref(agent.id).timeline)
      .then((timeline) => service.turnEnded(agent.id, timeline))
      // A child stopping may leave its parent's working card with nothing behind it.
      .then(() => assess(api))
      .then(() => afterStatusChange(api))
      .catch((error) => console.error("[status] turn bookkeeping failed", error));
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

  server.handle(listStatuses, async ({ workspaceId, withBacking }, { paseo: api }) => {
    capture(api);
    const live = await liveAgents(api);
    const statuses = visibleCards(helpersAmong(live.map((agent) => ({ id: agent.id, parentAgentId: parentOf(agent) }))), workspaceId).sort((a, b) =>
      b.updatedAt.localeCompare(a.updatedAt),
    );
    const agents = Object.fromEntries(
      live.map((agent) => [agent.id, withPluginTurn(agent.id, { title: agent.title ?? null, running: isRunning(agent) })]),
    );
    const workspaces = workspaceId
      ? {}
      : Object.fromEntries((await api.workspaces.list()).entries.map((workspace) => [workspace.id, workspace.title || workspace.name]));
    const silent = workspaceId ? silentAgents(live, workspaceId) : [];
    // Only the workspace summaries ask: it lists and probes every agent on the host.
    const backing =
      withBacking && !workspaceId
        ? await backingOf(api).catch((error) => {
            console.error("[status] could not work out what backs each card", error);
            return undefined;
          })
        : undefined;
    const blockers = await resolveBlockers(statuses).catch((error) => {
      console.error("[status] could not resolve blockers", error);
      return {};
    });
    return { statuses, silent, agents, workspaces, backing, blockers };
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
  server.handle(syncAsks, ({ agentId }, { paseo: api }) => {
    capture(api);
    return service.syncAsks(agentId);
  });

  const listening = listen(dir, {
    // The bridge sends its agent ID: helpers get neither.
    "/instructions": async ({ agentId }) => service.instructionsFor(agentId ?? null),
    "/tools": async ({ agentId }) => service.toolsFor(agentId ?? null),
    "/call": async ({ agentId, cwd, name, arguments: args }) => {
      const result = await service.callTool(agentId ?? (cwd ? await callerIn(cwd) : null), name, args);
      if (paseo) afterStatusChange(paseo);
      return result;
    },
    // The same Refresh the UI does, for scripts and terminal use.
    "/refresh": async (input) => service.refresh(refreshStatus.input.parse(input).agentId),
    // What each blocked card waits on, as the Overview shows it, for checking it from a terminal.
    "/blockers": async () => ({ blockers: await resolveBlockers(store.list()) }),
    // What backs each card, as Paseo's workspace attention gets it, for checking it from a terminal.
    "/backing": async () => ({ backing: await backingOf(requirePaseo()) }),
  });

  return async () => {
    if (wakeTimer) clearTimeout(wakeTimer);
    (await listening).close();
  };
}
