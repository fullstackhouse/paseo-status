import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const STATES = ["working", "waiting_on_you", "blocked", "done"] as const;
/** Turns without an update after which a card counts as stale: flagged, and refreshed when the panel opens. */
export const STALE_TURNS = 2;

export const BLOCKER_KINDS = ["pr", "agent", "workspace", "person", "other"] as const;

/**
 * One thing a blocked card waits on, as the agent names it. `ref`: a PR as `owner/repo#N` or its URL,
 * an agent id (full or a unique prefix), a workspace id, or a person's name.
 */
export const BlockerSchema = z.object({
  kind: z.enum(BLOCKER_KINDS),
  ref: z.string().trim().min(1).max(300),
  reason: z.string().max(300).optional(),
});
export type Blocker = z.infer<typeof BlockerSchema>;

/** A blocker as the server resolved it for display (FSH `PluginWorkspaceBlocker`). */
export const BlockerViewSchema = z.object({
  kind: z.enum(BLOCKER_KINDS),
  label: z.string(),
  /** Short facts, such as "open · checks failing", or the agent's reason. */
  detail: z.string().optional(),
  url: z.string().optional(),
  agentId: z.string().optional(),
  workspaceId: z.string().optional(),
  tone: z.enum(["success", "warning", "danger", "muted"]).optional(),
});
export type BlockerView = z.infer<typeof BlockerViewSchema>;

/** What an agent sends with status_set (or in a paseo-status reply block). */
export const StatusInputSchema = z.object({
  state: z.enum(STATES),
  /** The whole job and its overall progress. Sticky: omitted keeps the previous one, "" clears it. */
  goal: z.string().max(400).optional(),
  tldr: z.string().min(1).max(600),
  now: z.string().max(400).optional(),
  done: z.array(z.string().min(1).max(300)).max(12).default([]),
  next: z.array(z.string().min(1).max(300)).max(12).default([]),
  /** What a blocked card waits on. Replaced on each call; shown only while the state is blocked. */
  blockedBy: z.array(BlockerSchema).max(8).optional(),
  /**
   * A few words naming what the chat is about. Offered only to agents created while "Name chats from the status card"
   * is on (`TITLED_TOOLS`); optional so every call parses. Not stored on the card.
   */
  title: z.string().trim().max(60).optional(),
});
export type StatusInput = z.infer<typeof StatusInputSchema>;

/**
 * A done card with steps still in `next` isn't done. The app reads done as "the work shipped" and offers
 * Archive, so a card that still waits on the human to test or merge must say waiting_on_you.
 */
export const DONE_WITH_NEXT =
  "state is done, but next still lists steps. done means nothing is left for you or the human. Use waiting_on_you if the human has to act (test, review, merge, a manual step), working if a step is still yours. If nothing is actually left, send next empty.";

export function isDoneWithNext(input: Pick<StatusInput, "state" | "next">): boolean {
  return input.state === "done" && input.next.length > 0;
}

export const StatusSchema = z.object({
  agentId: z.string(),
  workspaceId: z.string(),
  state: z.enum(STATES),
  /** One or two plain sentences: what the whole job is and how far along it is. Survives updates that omit it. */
  goal: z.string().optional(),
  /** One or two plain sentences: where things stand right now. */
  tldr: z.string(),
  /** What the agent is doing or waiting on right now. */
  now: z.string().optional(),
  /** Finished work, each item with its proof. */
  done: z.array(z.string()),
  /** What is left, in order. */
  next: z.array(z.string()),
  /** What a blocked card waits on, as the agent named it. */
  blockedBy: z.array(BlockerSchema).optional(),
  updatedAt: z.string(),
  /** Turns that ended since the agent last called status_set. */
  turnsSince: z.number(),
  /** Turns since status_set that a person or a child agent started (`answersCard`); absent on cards written before it was counted. */
  repliesSince: z.number().optional(),
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
 * A waiting or blocked card no answering turn has started since: a reply (or a child agent reporting
 * back) starts a turn, which answers a waiting card even before the agent publishes again. Turns a
 * plugin starts on its own (`answersCard`) don't. A blocked card waits on another workspace or
 * person, so no turn answers it; only the agent's next `status_set` does.
 */
function stillWaiting(status: Status, agent: TurnState): boolean {
  if (status.state === "blocked") return true;
  if (status.state !== "waiting_on_you") return false;
  return (status.repliesSince ?? status.turnsSince) === 0 && !(runsReply(agent) && !status.setThisTurn);
}

// Prompts that plugins send on their own, not on the human's behalf: the fixed texts paseo-status
// (server/service.ts) and paseo-asks (shared/prompts.ts, server/watcher.ts) send. Hosts with
// `turnOrigin` say who sent a prompt (`answersTurn`); these patterns are the fallback for older hosts,
// and tell paseo-asks relaying the human's button press or reply from its own nudges.
// An `[asks]` message for a button press or reply is the human answering, so it counts.
/** Where a batch of plugin messages splits into its messages. */
const BATCHED = /\n(?=\[(?:asks|status)\] )/;
/** An `[asks]` message about one ask: a relayed answer, or the watcher's own update. */
const ASK_EVENT = /^\[asks\] A\d+ /;
const PLUGIN_PROMPTS: readonly RegExp[] = [
  /^\[status\] /,
  /^\[asks\] A check found that your last reply /,
  /^\[asks\] The human wants your asks up to date\./,
  /^\[asks\] Your turn ended with /,
  /^\[asks\] A\d+ \([\s\S]*?\) shows nothing moving: update it or hand it back\.$/,
  /^\[asks\] A\d+ \([\s\S]*?\) PR #\d+ [^.]*\.$/,
];

/**
 * Whether a turn started by `prompt` answers a waiting card: anything a person or a child agent sent
 * does; a plugin's own check, reminder, refresh or PR update doesn't. Batched `[asks]` messages are
 * read one by one, and any human one answers. Unknown (no prompt found) answers, as before.
 */
export function answersCard(prompt: string | undefined): boolean {
  if (prompt === undefined) return true;
  return prompt.split(BATCHED).some((part) => !PLUGIN_PROMPTS.some((re) => re.test(part)));
}

/**
 * Who sent the prompt that started a turn, as FSH hosts with `server_info.features.turnOrigin` stamp it
 * on `agent.turn.before` and on the turn's `user_message`. Mirrors the host's `AgentTurnOrigin`.
 */
export type TurnOrigin =
  | { kind: "human" }
  | { kind: "agent"; agentId?: string }
  | { kind: "plugin"; pluginId: string }
  | { kind: "system" };

/**
 * Whether a turn answers a waiting card, from who started it: a person or another agent does; the
 * daemon (schedules, restart recovery) doesn't; a plugin does only when it relays the human, which is
 * paseo-asks passing on a button press or reply (`[asks] A12 …` that `answersCard` accepts). A plugin
 * prompt worded any other way doesn't answer. Without an origin (older hosts) the prompt text decides.
 */
export function answersTurn(prompt: { text?: string; origin?: TurnOrigin } | undefined): boolean {
  const origin = prompt?.origin;
  if (!origin) return answersCard(prompt?.text);
  if (origin.kind === "human" || origin.kind === "agent") return true;
  if (origin.kind === "system") return false;
  return (prompt.text ?? "").split(BATCHED).some((part) => ASK_EVENT.test(part) && answersCard(part));
}

/**
 * An agent's current turn as the answered rule needs it. Every surface passes this, never a bare
 * `running` flag: a running turn a plugin started (an Asks check, a reminder) answers no card, and a
 * caller that passed `agent.running` made the chat pill read "answered" while Overview read waiting.
 */
export type TurnState = { running: boolean; pluginTurn?: boolean } | undefined;

/** The agent runs a turn that answers its card: one a person or child agent started, not a plugin. */
export function runsReply(agent: TurnState): boolean {
  return !!agent?.running && !agent.pluginTurn;
}

/** The prompt that started a turn, from `latestTurn`'s items, with its origin when the host stamped one. */
export function turnPrompt(
  turn: readonly { type: string; text?: string; origin?: TurnOrigin }[],
): { text?: string; origin?: TurnOrigin } | undefined {
  const item = turn.find((entry) => entry.type === "user_message");
  return item ? { text: item.text, ...(item.origin ? { origin: item.origin } : {}) } : undefined;
}

/**
 * The card asks for the human and is still unanswered. A blocked card waits on another workspace or
 * another person instead, so it never needs you.
 */
export function needsYou(status: Status, agent: TurnState): boolean {
  if (status.state !== "waiting_on_you") return false;
  return stillWaiting(status, agent);
}

/**
 * A waiting card a turn started after: the human replied, or a child agent reported back.
 * A blocked card is never answered (see `stillWaiting`).
 */
export function isAnswered(status: Status, agent: TurnState): boolean {
  return status.state !== "working" && status.state !== "done" && !stillWaiting(status, agent);
}

/** How loud a card's state badge reads. A blocked card waits on someone else, so it reads calm. */
export function stateTone(status: Status, answered: boolean): "muted" | "warn" | "good" {
  if (answered) return "muted";
  if (status.state === "waiting_on_you") return "warn";
  return status.state === "done" ? "good" : "muted";
}

/** A card as the host's Overview shows it (FSH `PluginWorkspaceSummaryItemState.status`). */
export interface OverviewStatus {
  state: Status["state"];
  /** True once an agent turn started after the card was written: the human already replied. */
  answered?: boolean;
  /** The whole job and its overall progress, shown above the Status card. */
  goal?: string;
  summary: string;
  now?: string;
  /** Epoch ms of the card's last update. */
  updatedAt: number;
  /** What a blocked card waits on, resolved for display. Only while the state is blocked; older hosts drop it. */
  blockedBy?: BlockerView[];
}

export function overviewStatus(status: Status, agent: TurnState, blockers: readonly BlockerView[] = []): OverviewStatus {
  return {
    state: status.state,
    ...(isAnswered(status, agent) ? { answered: true } : {}),
    ...(status.goal ? { goal: status.goal } : {}),
    summary: status.tldr,
    ...(status.now ? { now: status.now } : {}),
    updatedAt: Date.parse(status.updatedAt),
    ...(status.state === "blocked" && blockers.length > 0 ? { blockedBy: [...blockers] } : {}),
  };
}

/**
 * The Overview status for a workspace: its newest card, with the newest goal any agent there set,
 * since a helper agent's card often has none.
 */
export function workspaceOverviewStatus(
  cards: readonly Status[],
  agentOf: (agentId: string) => TurnState,
  blockers: Readonly<Record<string, readonly BlockerView[]>> = {},
): OverviewStatus | null {
  const latest = newestCard(cards);
  if (!latest) return null;
  const status = overviewStatus(latest, agentOf(latest.agentId), blockers[latest.agentId]);
  const goal = newestCard(cards.filter((card) => card.goal))?.goal;
  return goal ? { ...status, goal } : status;
}

export function newestCard(cards: readonly Status[]): Status | undefined {
  return cards.reduce<Status | undefined>((latest, card) => (!latest || card.updatedAt > latest.updatedAt ? card : latest), undefined);
}

/** What backs one agent's card right now, as the server sees it. */
export interface Backing {
  /** The agent itself is mid-turn. */
  running: boolean;
  /** The running turn was started by a plugin's own prompt (`answersCard`), so it answers no card. */
  pluginTurn?: boolean;
  /** The agent, its background work (shells, watches), or a descendant agent (or its background work) is live. */
  live: boolean;
  /** When live work was last seen for this agent (epoch ms), if it was. */
  lastLiveAt?: number;
  /** For an idle agent with a waiting card: its descendants live in other workspaces. */
  liveChildren?: string[];
}

/**
 * One agent's card as facts for Paseo's workspace attention (FSH `PluginWorkspaceAgentCard`). Paseo decides
 * from these whether the workspace needs you, works, is blocked or is done; this plugin only reports them.
 */
export interface AgentCard {
  agentId: string;
  state: Status["state"];
  /** A turn started after the card was written: the human replied, or a child reported back. */
  answered?: boolean;
  /** Epoch ms of the card's last update. */
  updatedAt: number;
  /** The agent, its background work, or a descendant agent is live right now. */
  live?: boolean;
  /** When live work was last seen for this agent (epoch ms). */
  lastLiveAt?: number;
  /** Descendant agents live in other workspaces, for an idle agent with a waiting card. */
  liveChildren?: string[];
}

export function agentCard(status: Status, backing: Backing): AgentCard {
  return {
    agentId: status.agentId,
    state: status.state,
    ...(isAnswered(status, backing) ? { answered: true } : {}),
    updatedAt: Date.parse(status.updatedAt),
    ...(backing.live ? { live: true } : {}),
    ...(backing.lastLiveAt !== undefined ? { lastLiveAt: backing.lastLiveAt } : {}),
    ...(backing.liveChildren?.length ? { liveChildren: [...backing.liveChildren] } : {}),
  };
}

export const BackingSchema = z.object({
  running: z.boolean(),
  /** The running turn was started by a plugin's own prompt (`answersCard`), so it answers no card. */
  pluginTurn: z.boolean().optional(),
  live: z.boolean(),
  lastLiveAt: z.number().optional(),
  liveChildren: z.array(z.string()).optional(),
});

/**
 * The agent to report when a snoozed workspace needs you: the newest card written after the snooze began that
 * still waits on the human (see `needsYou`), or, once every card says done, says done. A workspace that already
 * needed you when it was snoozed stays snoozed; the human snoozed it knowing that. A blocked card waits on
 * someone else, so it never wakes one. Only a trigger: Paseo decides how the workspace groups.
 */
export function needsYouSince(statuses: readonly Status[], snoozedAt: string, agentOf: (agentId: string) => TurnState): string | null {
  const cards = statuses.filter((status) => !status.archived);
  const allDone = cards.length > 0 && cards.every((status) => status.state === "done");
  const since = Date.parse(snoozedAt);
  const newest = cards
    .filter((status) => Date.parse(status.updatedAt) > since)
    .filter((status) => (allDone ? true : needsYou(status, agentOf(status.agentId))))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return newest?.agentId ?? null;
}

/** A live agent in the workspace that has not published a status. */
export const SilentAgentSchema = z.object({ agentId: z.string(), title: z.string().nullable() });
export type SilentAgent = z.infer<typeof SilentAgentSchema>;

export const listStatuses = defineRpc({
  name: "status.list",
  input: z.object({
    workspaceId: z.string().optional(),
    /** Also report what backs each card (`backing`); costs a scan of every agent on the host. */
    withBacking: z.boolean().optional(),
  }),
  output: z.object({
    statuses: z.array(StatusSchema),
    silent: z.array(SilentAgentSchema),
    /** Looked up on the server: Paseo's state hooks only work inside a workspace panel, not on screens or popovers. */
    agents: z.record(z.string(), z.object({ title: z.string().nullable(), running: z.boolean(), pluginTurn: z.boolean().optional() })),
    workspaces: z.record(z.string(), z.string()),
    /** Per agent with a card: what backs it, for Paseo's workspace attention; only when asked for with `withBacking`. */
    backing: z.record(z.string(), BackingSchema).optional(),
    /** Per agent whose card is blocked and names what it waits on, resolved on the server (PR state, agent titles). */
    blockers: z.record(z.string(), z.array(BlockerViewSchema)).optional(),
  }),
});

export type StatusList = z.infer<typeof listStatuses.output>;

/** Ask an agent whose card waits on the human without an open ask to bring its asks and card in line. */
export const syncAsks = defineRpc({
  name: "status.sync-asks",
  input: z.object({ agentId: z.string() }),
  output: z.object({ sent: z.boolean() }),
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
