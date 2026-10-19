import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { STATES, type Status, type Waiting } from "../shared/status";
import type { StatusStore } from "./store";

export const INSTRUCTIONS = `status_set publishes where your work stands to a status card the human reads in Paseo instead of asking you "where are we?".
- Call it at the end of every turn that changed where things stand: started, finished or abandoned a step, got a result, became blocked, or started waiting on the human. Skip it for turns that changed nothing.
- Each call replaces the whole status, so send all fields every time.
- Write for someone who skipped the transcript: plain words, no internal jargon, no file paths unless they matter.
  - tldr: one or two sentences. What this work is and where it stands.
  - now: what you are doing or waiting on this moment.
  - done: finished steps, each with its proof ("tests pass: 105/105", "PR #22 open, CI green"). Say "not committed" or "not pushed" when that is true.
  - next: what is left, in order. Mark what needs the human.
  - state: working, waiting_on_you, blocked or done.
- Messages starting with [status] are the human asking for an update: call status_set.`;

const SetInput = z.object({
  state: z.enum(STATES),
  tldr: z.string().min(1).max(600),
  now: z.string().max(400).optional(),
  done: z.array(z.string().min(1).max(300)).max(12).default([]),
  next: z.array(z.string().min(1).max(300)).max(12).default([]),
});

export const TOOLS = [
  {
    name: "status_set",
    description: "Publish where your work stands (replaces your previous status). See the server instructions for when and how.",
    inputSchema: z.toJSONSchema(SetInput, { io: "input" }),
  },
];

export const REFRESH_PROMPT =
  "[status] The human asked where things stand. Call status_set with your current status, then carry on with what you were doing, if anything.";

export type AgentState = "idle" | "running" | "gone";

export interface Courier {
  state(agentId: string): Promise<AgentState>;
  send(agentId: string, text: string): Promise<void>;
}

export interface ToolResult {
  text: string;
  isError?: boolean;
}

export class StatusService {
  constructor(
    private readonly store: StatusStore,
    private readonly courier: Courier,
    private readonly workspaceOf: (agentId: string) => Promise<string | null>,
  ) {}

  async callTool(agentId: string | null, name: string, args: unknown): Promise<ToolResult> {
    try {
      if (name !== "status_set") throw new Error(`Unknown tool ${name}`);
      if (!agentId) throw new Error("PASEO_AGENT_ID is not set for this agent, so the status has no owner");
      const workspaceId = await this.workspaceOf(agentId);
      if (!workspaceId) throw new Error(`Agent ${agentId} has no workspace`);
      const status = this.store.set(workspaceId, agentId, SetInput.parse(args));
      return { text: `Status published (${status.state}).` };
    } catch (error) {
      const text = error instanceof z.ZodError ? z.prettifyError(error) : error instanceof Error ? error.message : String(error);
      return { text, isError: true };
    }
  }

  /** The human pressed Refresh. A send mid-turn would interrupt the agent, so that case waits for the turn to end. */
  async refresh(agentId: string): Promise<{ sent: boolean }> {
    const state = await this.courier.state(agentId);
    if (state === "gone") throw new Error("That agent is archived");
    if (state === "running") {
      if (this.store.get(agentId)) this.store.patch(agentId, { refreshPending: true });
      else this.pendingWithoutStatus.add(agentId);
      return { sent: false };
    }
    await this.courier.send(agentId, REFRESH_PROMPT);
    return { sent: true };
  }

  async turnEnded(agentId: string): Promise<void> {
    const status = this.store.turnEnded(agentId);
    const pending = status?.refreshPending || this.pendingWithoutStatus.delete(agentId);
    if (!pending) return;
    if (status) this.store.patch(agentId, { refreshPending: false });
    // The turn that just ended already answered the request.
    if (status && status.turnsSince === 0) return;
    await this.courier.send(agentId, REFRESH_PROMPT);
  }

  /** Refresh requests for agents that have never published a status; in memory only. */
  private readonly pendingWithoutStatus = new Set<string>();
}

/** Open asks from the asks plugin's store, if that plugin is installed. Never written to. */
export function readWaiting(asksDir: string, workspaceIds: readonly string[]): Waiting[] {
  const waiting: Waiting[] = [];
  for (const workspaceId of workspaceIds) {
    const path = join(asksDir, "workspaces", `${encodeURIComponent(workspaceId)}.json`);
    if (!existsSync(path)) continue;
    try {
      const file = JSON.parse(readFileSync(path, "utf8")) as { asks?: { id: string; title: string; ownerAgentId: string; status: string }[] };
      for (const ask of file.asks ?? []) {
        if (ask.status === "open") waiting.push({ id: ask.id, title: ask.title, agentId: ask.ownerAgentId });
      }
    } catch (error) {
      console.error(`[status] could not read asks for ${workspaceId}`, error);
    }
  }
  return waiting;
}

export function workspacesOf(statuses: readonly Status[]): string[] {
  return [...new Set(statuses.map((status) => status.workspaceId))];
}
