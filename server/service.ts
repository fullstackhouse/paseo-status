import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { z } from "zod";
import { STALE_TURNS, STATES, type Status, type Waiting } from "../shared/status";
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

/** For agents created before the plugin was installed: they have no tool, so the status rides in their reply. */
export const FALLBACK_PROMPT = `[status] The human asked where things stand, for a status card shown outside this chat. End your reply with a fenced code block tagged paseo-status holding one JSON object:
\`\`\`paseo-status
{"state": "working | waiting_on_you | blocked | done", "tldr": "one or two plain sentences: what this work is and where it stands", "now": "what you are doing or waiting on", "done": ["finished step, with its proof"], "next": ["what is left, in order; mark what needs the human"]}
\`\`\`
Write for someone who skipped the transcript. Say "not committed" or "not pushed" when that is true. Then carry on with what you were doing, if anything.`;

const FENCED = /```paseo-status[^\n]*\n([\s\S]*?)```/g;

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
    /** Created while the plugin was installed, so it has the status_set tool. */
    private readonly isEquipped: (agentId: string) => boolean = () => true,
    private readonly now: () => Date = () => new Date(),
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

  /**
   * Ask one agent for an update. A send mid-turn would interrupt the agent, so that case waits
   * for the turn to end. `auto` asks at most once per update, so reopening the panel never nags.
   */
  async refresh(agentId: string, { auto = false } = {}): Promise<{ sent: boolean; skipped?: boolean }> {
    const status = this.store.get(agentId);
    // An update clears refreshRequestedAt, so a set value means the last request is still unanswered.
    if (auto && status?.refreshRequestedAt) return { sent: false, skipped: true };
    const state = await this.courier.state(agentId);
    if (state === "gone") throw new Error("That agent is archived");
    if (status) this.store.patch(agentId, { refreshRequestedAt: this.now().toISOString() });
    if (state === "running") {
      if (status) this.store.patch(agentId, { refreshPending: true });
      else this.pendingWithoutStatus.add(agentId);
      return { sent: false };
    }
    await this.courier.send(agentId, this.prompt(agentId));
    return { sent: true };
  }

  /**
   * The panel opening (`auto`: stale cards only) or the Refresh button (every card that missed a
   * turn, plus `silent` agents that never published one). Returns how many agents were asked.
   */
  async refreshAll(workspaceId: string | undefined, { auto = false, silent = [] as string[] } = {}): Promise<{ asked: number }> {
    const threshold = auto ? STALE_TURNS : 1;
    const targets = [
      ...this.store
        .list(workspaceId)
        .filter((status) => status.turnsSince >= threshold && !status.refreshPending)
        .map((status) => status.agentId),
      ...(auto ? [] : silent),
    ];
    let asked = 0;
    for (const agentId of targets) {
      try {
        if (!(await this.refresh(agentId, { auto })).skipped) asked += 1;
      } catch (error) {
        console.error(`[status] could not refresh ${agentId}`, error);
      }
    }
    return { asked };
  }

  async turnEnded(agentId: string, timeline: readonly AgentTimelineItem[] = []): Promise<void> {
    await this.captureFromReply(agentId, timeline);
    const status = this.store.turnEnded(agentId);
    const pending = status?.refreshPending || this.pendingWithoutStatus.delete(agentId);
    if (!pending) return;
    if (status) this.store.patch(agentId, { refreshPending: false });
    // The turn that just ended already answered the request.
    if (status && status.turnsSince === 0) return;
    await this.courier.send(agentId, this.prompt(agentId));
  }

  private prompt(agentId: string): string {
    return this.isEquipped(agentId) ? REFRESH_PROMPT : FALLBACK_PROMPT;
  }

  /** A paseo-status block at the end of the reply counts as status_set (the fallback for tool-less agents). */
  private async captureFromReply(agentId: string, timeline: readonly AgentTimelineItem[]): Promise<void> {
    const blocks = [...latestReply(timeline).matchAll(FENCED)];
    const raw = blocks.at(-1)?.[1];
    if (!raw) return;
    try {
      const workspaceId = await this.workspaceOf(agentId);
      if (!workspaceId) return;
      this.store.set(workspaceId, agentId, SetInput.parse(JSON.parse(raw)));
    } catch (error) {
      console.error(`[status] unreadable paseo-status block from ${agentId}`, error);
    }
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

/** The assistant text after the last user message; streamed replies arrive as several items. */
export function latestReply(timeline: readonly AgentTimelineItem[]): string {
  const parts: string[] = [];
  for (let index = timeline.length - 1; index >= 0; index--) {
    const item = timeline[index]!;
    if (item.type === "user_message") break;
    if (item.type === "assistant_message") parts.unshift(item.text);
  }
  return parts.join("");
}
