import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const STATES = ["working", "waiting_on_you", "blocked", "done"] as const;
/** Turns without an update after which a card counts as stale: flagged, and refreshed when the panel opens. */
export const STALE_TURNS = 2;

/** What an agent sends with status_set (or in a paseo-status reply block). */
export const StatusInputSchema = z.object({
  state: z.enum(STATES),
  tldr: z.string().min(1).max(600),
  now: z.string().max(400).optional(),
  done: z.array(z.string().min(1).max(300)).max(12).default([]),
  next: z.array(z.string().min(1).max(300)).max(12).default([]),
});
export type StatusInput = z.infer<typeof StatusInputSchema>;

export const StatusSchema = z.object({
  agentId: z.string(),
  workspaceId: z.string(),
  state: z.enum(STATES),
  /** One or two plain sentences: where things stand. */
  tldr: z.string(),
  /** What the agent is doing or waiting on right now. */
  now: z.string().optional(),
  /** Finished work, each item with its proof. */
  done: z.array(z.string()),
  /** What is left, in order. */
  next: z.array(z.string()),
  updatedAt: z.string(),
  /** Turns that ended since the agent last called status_set. */
  turnsSince: z.number(),
  /** status_set was called during the turn now running; cleared when it ends. */
  setThisTurn: z.boolean().optional(),
  /** The human pressed Refresh while the agent was mid-turn; the request goes out when it ends. */
  refreshPending: z.boolean().optional(),
  /** When an update was requested and not yet answered (status_set clears it); auto refresh skips these. */
  refreshRequestedAt: z.string().optional(),
  archived: z.boolean().optional(),
});
export type Status = z.infer<typeof StatusSchema>;

/**
 * The card asks for the human and no turn has started since: a reply (or any other prompt) starts
 * a turn, which answers it even before the agent publishes again.
 */
export function needsYou(status: Status, running: boolean): boolean {
  if (status.state !== "waiting_on_you" && status.state !== "blocked") return false;
  return status.turnsSince === 0 && !(running && !status.setThisTurn);
}

/** A waiting or blocked card the human already replied to: a turn started after it was written. */
export function isAnswered(status: Status, running: boolean): boolean {
  return status.state !== "working" && status.state !== "done" && !needsYou(status, running);
}

/** A card as the host's Overview shows it (FSH `PluginWorkspaceSummaryItemState.status`). */
export interface OverviewStatus {
  state: Status["state"];
  /** True once an agent turn started after the card was written: the human already replied. */
  answered?: boolean;
  summary: string;
  now?: string;
  /** Epoch ms of the card's last update. */
  updatedAt: number;
}

export function overviewStatus(status: Status, running: boolean): OverviewStatus {
  return {
    state: status.state,
    ...(isAnswered(status, running) ? { answered: true } : {}),
    summary: status.tldr,
    ...(status.now ? { now: status.now } : {}),
    updatedAt: Date.parse(status.updatedAt),
  };
}

/**
 * How long a `working` card keeps an idle workspace in Paseo's Working group once nothing live backs it:
 * counted from the card's update or the last live work it saw, whichever is later. Covers gaps between turns.
 */
export const WORKING_GRACE_MS = 5 * 60 * 1000;

/** What backs one agent's card right now, as the server sees it. */
export interface Backing {
  /** The agent itself is mid-turn. */
  running: boolean;
  /** The agent, its background work (shells, watches), or a descendant agent (or its background work) is live. */
  live: boolean;
  /** When live work was last seen for this agent (epoch ms), if it was. */
  lastLiveAt?: number;
}

export type WorkState = "waiting" | "working" | "done";

/**
 * Where one workspace's work stands for Paseo's experimental agent-reported sidebar grouping, from
 * the cards of its agents: `waiting` while a card still waits on the human (see `needsYou`); `working`
 * while live work backs a `working` card, or within `WORKING_GRACE_MS` of its update or of the last live
 * work: a claim nothing backs is not believed. `null` leaves the workspace to Paseo's own turn state, as
 * for an answered question. A `done` card counts even when stale: agents skip status_set on
 * turns that change nothing (answering an ask, a reminder), and those turns must not drop the workspace
 * back to Ready to review.
 */
export function workspaceWorkState(
  statuses: readonly Status[],
  now: number,
  backing: (agentId: string) => Backing = () => ({ running: false, live: false }),
): WorkState | null {
  const cards = statuses.filter((status) => !status.archived);
  if (cards.length === 0) return null;
  if (cards.some((status) => needsYou(status, backing(status.agentId).running))) return "waiting";
  if (cards.some((status) => status.state === "waiting_on_you" || status.state === "blocked")) return null;
  const heldWorking = cards.some((status) => {
    if (status.state !== "working") return false;
    const { live, lastLiveAt = 0 } = backing(status.agentId);
    return live || now - Math.max(Date.parse(status.updatedAt), lastLiveAt) < WORKING_GRACE_MS;
  });
  if (heldWorking) return "working";
  if (cards.every((status) => status.state === "done")) return "done";
  return null;
}

/**
 * The agent to report when a snoozed workspace needs you: its work state (`workspaceWorkState`) is
 * `waiting` or `done`, and the card that says so was written after the snooze began. A workspace that
 * already needed you when it was snoozed stays snoozed; the human snoozed it knowing that.
 */
export function needsYouSince(statuses: readonly Status[], state: WorkState | null, snoozedAt: string): string | null {
  if (state !== "waiting" && state !== "done") return null;
  const says = (status: Status) =>
    state === "waiting" ? status.state === "waiting_on_you" || status.state === "blocked" : status.state === "done";
  const since = Date.parse(snoozedAt);
  const newest = statuses
    .filter((status) => !status.archived && says(status) && Date.parse(status.updatedAt) > since)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return newest?.agentId ?? null;
}

/** An open ask from the asks plugin, when it is installed. Read-only. */
export const WaitingSchema = z.object({ id: z.string(), title: z.string(), agentId: z.string() });
export type Waiting = z.infer<typeof WaitingSchema>;

/** A live agent in the workspace that has not published a status. */
export const SilentAgentSchema = z.object({ agentId: z.string(), title: z.string().nullable() });
export type SilentAgent = z.infer<typeof SilentAgentSchema>;

export const listStatuses = defineRpc({
  name: "status.list",
  input: z.object({
    workspaceId: z.string().optional(),
    /** Also work out `workStates` (every workspace only); costs a scan of every agent on the host. */
    withWorkStates: z.boolean().optional(),
  }),
  output: z.object({
    statuses: z.array(StatusSchema),
    waiting: z.array(WaitingSchema),
    silent: z.array(SilentAgentSchema),
    /** Looked up on the server: Paseo's state hooks only work inside a workspace panel, not on screens or popovers. */
    agents: z.record(z.string(), z.object({ title: z.string().nullable(), running: z.boolean() })),
    workspaces: z.record(z.string(), z.string()),
    /** Per workspace with a card, for Paseo's sidebar grouping; only when asked for with `withWorkStates`. */
    workStates: z.record(z.string(), z.enum(["waiting", "working", "done"]).nullable()).optional(),
  }),
});

/** Ask an agent to update its status. Sent now if it is idle or can take a steer, otherwise when its turn ends. */
export const refreshStatus = defineRpc({
  name: "status.refresh",
  input: z.object({ agentId: z.string() }),
  output: z.object({ sent: z.boolean() }),
});

/**
 * Bring a workspace (or every workspace) up to date: ask each agent whose card is out of date.
 * `auto` is the panel opening: only stale cards, at most once per update. Otherwise the Refresh
 * button: every card that missed a turn, plus agents with no card yet.
 */
export const refreshAll = defineRpc({
  name: "status.refresh-all",
  input: z.object({ workspaceId: z.string().optional(), auto: z.boolean().optional() }),
  output: z.object({ asked: z.number() }),
});

/** Where a workspace stands at a glance. */
export const WORKSPACE_STATES = ["needs_you", "working", "done"] as const;
export type WorkspaceState = (typeof WORKSPACE_STATES)[number];

export const WorkspaceSummarySchema = z.object({
  state: z.enum(WORKSPACE_STATES),
  /** Open asks plus cards that need the human. */
  waiting: z.number(),
});
export type WorkspaceSummary = z.infer<typeof WorkspaceSummarySchema>;

/** One summary per workspace on this host that has a card, an open ask, or a live agent. */
export const summarizeWorkspaces = defineRpc({
  name: "status.summary",
  input: z.object({}),
  output: z.object({ workspaces: z.record(z.string(), WorkspaceSummarySchema) }),
});

/**
 * Needs you beats working beats done. An open ask or a card asking for the human needs you, counted once:
 * a waiting card whose agent has open asks is the same request, so only its asks count. A running
 * agent or a card that says work goes on is working, even between turns. Paseo's own status only
 * sees the agent stop, so it calls a workspace done while its agents still have work queued.
 */
export function summarize(input: {
  statuses: readonly Status[];
  /** The owning agent of each open ask, per workspace. */
  openAsks: Readonly<Record<string, readonly string[]>>;
  /** Live agents with the workspace they are in. */
  agents: readonly { workspaceId: string; running: boolean }[];
  running: (agentId: string) => boolean;
}): Record<string, WorkspaceSummary> {
  const result: Record<string, WorkspaceSummary> = {};
  const at = (workspaceId: string) => (result[workspaceId] ??= { state: "done", waiting: 0 });
  const raise = (summary: WorkspaceSummary, state: WorkspaceState) => {
    if (WORKSPACE_STATES.indexOf(state) < WORKSPACE_STATES.indexOf(summary.state)) summary.state = state;
  };
  for (const agent of input.agents) {
    const summary = at(agent.workspaceId);
    if (agent.running) raise(summary, "working");
  }
  for (const status of input.statuses) {
    const summary = at(status.workspaceId);
    if (needsYou(status, input.running(status.agentId))) {
      if (!input.openAsks[status.workspaceId]?.includes(status.agentId)) summary.waiting += 1;
      raise(summary, "needs_you");
    } else if (status.state === "working") raise(summary, "working");
  }
  for (const [workspaceId, owners] of Object.entries(input.openAsks)) {
    if (owners.length === 0) continue;
    const summary = at(workspaceId);
    summary.waiting += owners.length;
    raise(summary, "needs_you");
  }
  return result;
}

/**
 * The sidebar row badge: only "needs you". Paseo's own sections already show working and done,
 * so repeating them added noise; open asks and cards waiting on the human are what Paseo can't see.
 */
export function rowBadgeLabel(summary: WorkspaceSummary | undefined): string | null {
  if (summary?.state !== "needs_you") return null;
  return summary.waiting > 1 ? `needs you (${summary.waiting})` : "needs you";
}
