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

/** An open ask from the asks plugin, when it is installed. Read-only. */
export const WaitingSchema = z.object({ id: z.string(), title: z.string(), agentId: z.string() });
export type Waiting = z.infer<typeof WaitingSchema>;

/** A live agent in the workspace that has not published a status. */
export const SilentAgentSchema = z.object({ agentId: z.string(), title: z.string().nullable() });
export type SilentAgent = z.infer<typeof SilentAgentSchema>;

export const listStatuses = defineRpc({
  name: "status.list",
  input: z.object({ workspaceId: z.string().optional() }),
  output: z.object({
    statuses: z.array(StatusSchema),
    waiting: z.array(WaitingSchema),
    silent: z.array(SilentAgentSchema),
    /** Looked up on the server: Paseo's state hooks only work inside a workspace panel, not on screens or popovers. */
    agents: z.record(z.string(), z.object({ title: z.string().nullable(), running: z.boolean() })),
    workspaces: z.record(z.string(), z.string()),
  }),
});

/** Ask an agent to update its status. Sent now if it is idle, otherwise when its turn ends. */
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
