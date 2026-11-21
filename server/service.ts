import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { z } from "zod";
import { STALE_TURNS, StatusInputSchema, type Status, type Waiting } from "../shared/status";
import type { StatusStore } from "./store";

export const INSTRUCTIONS = `status_set publishes where your work stands to a status card the human reads in Paseo instead of asking you "where are we?".
- Call it at the end of every turn that changed where things stand: started, finished or abandoned a step, got a result, became blocked, or started waiting on the human. Skip it for turns that changed nothing.
- Call it before your final reply, and add no closing line after it: a collapsed turn shows only its last message, so a short line after the status card would hide your answer.
- Each call replaces the whole status, so send every field every time, except goal.
- Write for someone who skipped the transcript: plain words, no internal jargon, no file paths unless they matter.
  - goal: one or two sentences on the whole job and its overall progress, so someone opening this workspace cold knows what it is for ("Ship the record-page redesign from #966 as 7 stacked PRs; 4 merged, QA fixes next"). Send it on your first call and again when the job or its overall progress changes; leaving it out keeps the last one.
  - tldr: one or two sentences. Where things stand right now.
  - now: what you are doing or waiting on this moment.
  - done: finished steps, each with its proof ("tests pass: 105/105", "PR #22 open, CI green"). Say "not committed" or "not pushed" when that is true.
  - next: what is left, in order. Mark what needs the human.
  - state: working, waiting_on_you, blocked or done. Use working while you, a heartbeat or a background job still own the next step; waiting_on_you when the human has to act; blocked only when nothing can move until another workspace or another person acts (a child workspace still running, a peer's code review), not for CI, builds, deploys or your own subagents, which are working; done once nothing is left.
  - blockedBy: with state blocked, what you wait on, each {kind, ref, reason?}: pr (ref "owner/repo#N" or URL), agent (agent id), workspace (workspace id), person (a name) or other.
- Messages starting with [status] are the human asking for an update: call status_set.`;

const SetInput = StatusInputSchema;

/** What an agent in a background workspace gets back instead of a status card. */
export const BACKGROUND_SKIP =
  "Skipped: this workspace runs in the background (an automated run hidden from the sidebar), so nobody reads its status. Put what you have in your final reply. status_set works again once the human opens this chat.";

export const TOOLS = [
  {
    name: "status_set",
    description: "Publish where your work stands (replaces your previous status). When blocked, name what blocks you in blockedBy. See the server instructions for when and how.",
    inputSchema: z.toJSONSchema(SetInput, { io: "input" }),
  },
];

export const REFRESH_PROMPT =
  "[status] The human asked where things stand. Call status_set with your current status, then carry on with what you were doing, if anything.";

/** Sent once when the last agent a parent started stops while the parent sits idle with a working or blocked card. */
export const WAKE_PROMPT =
  "[status] Every agent you started has stopped and nothing of yours is running, but your status still says working or blocked. Check what your child agents left, carry on if something remains, and call status_set with where things stand.";

/** For agents created before the plugin was installed: they have no tool, so the status rides in their reply. */
export const FALLBACK_PROMPT = `[status] The human asked where things stand, for a status card shown outside this chat. End your reply with a fenced code block tagged paseo-status holding one JSON object:
\`\`\`paseo-status
{"state": "working | waiting_on_you | blocked | done", "goal": "one or two plain sentences: the whole job and its overall progress", "tldr": "one or two plain sentences: where things stand right now", "now": "what you are doing or waiting on", "done": ["finished step, with its proof"], "next": ["what is left, in order; mark what needs the human"]}
\`\`\`
Write for someone who skipped the transcript. Say "not committed" or "not pushed" when that is true. Then carry on with what you were doing, if anything.`;

const FENCED = /```paseo-status[^\n]*\n([\s\S]*?)```/g;

/** `steerable`: mid-turn, on a provider that takes a steer into the running turn instead of interrupting it. */
export type AgentState = "idle" | "steerable" | "running" | "gone";

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
    /**
     * Background workspaces (hidden from the sidebar, e.g. Inbox review runs) get no status cards and are left out of
     * Refresh all: nobody reads their cards, and the prompt starts a turn that a plugin like paseo-inbox takes for the
     * human stepping in. status_set stays, since an agent's tools are fixed when it is created and the human may take
     * the run over later.
     */
    private readonly isBackground: (workspaceId: string) => Promise<boolean> = async () => false,
  ) {}

  async callTool(agentId: string | null, name: string, args: unknown): Promise<ToolResult> {
    try {
      if (name !== "status_set") throw new Error(`Unknown tool ${name}`);
      if (!agentId) throw new Error("PASEO_AGENT_ID is not set for this agent, so the status has no owner");
      const workspaceId = await this.workspaceOf(agentId);
      if (!workspaceId) throw new Error(`Agent ${agentId} has no workspace`);
      if (await this.isBackground(workspaceId).catch(() => false)) return { text: BACKGROUND_SKIP };
      const status = this.store.set(workspaceId, agentId, SetInput.parse(args));
      return { text: `Status published (${status.state}).` };
    } catch (error) {
      const text = error instanceof z.ZodError ? z.prettifyError(error) : error instanceof Error ? error.message : String(error);
      return { text, isError: true };
    }
  }

  /**
   * Ask one agent for an update: now if it is idle or can take a steer into its running turn. On a
   * provider without steering a send mid-turn would interrupt the agent, so that case waits for the
   * turn to end (with the plain refresh prompt: `prompt` only replaces it for a send that goes out now).
   * `auto` asks at most once per update, so reopening the panel never nags.
   */
  async refresh(agentId: string, { auto = false, prompt }: { auto?: boolean; prompt?: string } = {}): Promise<{ sent: boolean; skipped?: boolean }> {
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
    await this.courier.send(agentId, prompt ?? this.prompt(agentId));
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
        .map((status) => ({ agentId: status.agentId, workspaceId: status.workspaceId })),
      ...(auto || !workspaceId ? [] : silent.map((agentId) => ({ agentId, workspaceId }))),
    ];
    const background = new Map<string, Promise<boolean>>();
    const hidden = (id: string) => {
      if (!background.has(id)) background.set(id, this.isBackground(id).catch(() => false));
      return background.get(id)!;
    };
    let asked = 0;
    for (const { agentId, workspaceId: targetWorkspace } of targets) {
      if (await hidden(targetWorkspace)) continue;
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

  /** An idle agent's working or blocked card lost its last live child: ask it to look at its children and update. */
  async wake(agentId: string): Promise<{ sent: boolean }> {
    return this.refresh(agentId, { prompt: this.isEquipped(agentId) ? WAKE_PROMPT : FALLBACK_PROMPT });
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

/** The owning agent of each open ask, per workspace, across every workspace the asks plugin has a file for. Never written to. */
export function readOpenAskOwners(asksDir: string): Record<string, string[]> {
  const dir = join(asksDir, "workspaces");
  if (!existsSync(dir)) return {};
  const owners: Record<string, string[]> = {};
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const workspaceId = decodeURIComponent(file.slice(0, -".json".length));
    try {
      const parsed = JSON.parse(readFileSync(join(dir, file), "utf8")) as { asks?: { status: string; ownerAgentId: string }[] };
      const open = (parsed.asks ?? []).filter((ask) => ask.status === "open").map((ask) => ask.ownerAgentId);
      if (open.length > 0) owners[workspaceId] = open;
    } catch (error) {
      console.error(`[status] could not read asks for ${workspaceId}`, error);
    }
  }
  return owners;
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
