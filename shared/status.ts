import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const STATES = ["working", "waiting_on_you", "blocked", "done"] as const;

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
  archived: z.boolean().optional(),
});
export type Status = z.infer<typeof StatusSchema>;

/** An open ask from the asks plugin, when it is installed. Read-only. */
export const WaitingSchema = z.object({ id: z.string(), title: z.string(), agentId: z.string() });
export type Waiting = z.infer<typeof WaitingSchema>;

export const listStatuses = defineRpc({
  name: "status.list",
  input: z.object({ workspaceId: z.string().optional() }),
  output: z.object({ statuses: z.array(StatusSchema), waiting: z.array(WaitingSchema) }),
});

/** Ask an agent to update its status. Sent now if it is idle, otherwise when its turn ends. */
export const refreshStatus = defineRpc({
  name: "status.refresh",
  input: z.object({ agentId: z.string() }),
  output: z.object({ sent: z.boolean() }),
});
