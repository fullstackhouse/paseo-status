import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { z } from "zod";
import { answersTurn, DONE_WITH_NEXT, isDoneWithNext, STALE_TURNS, StatusInputSchema, turnPrompt, type Status, type TurnOrigin } from "../shared/status";
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
  - state: working, waiting_on_you, blocked or done. Use working while you, a heartbeat or a background job still own the next step; waiting_on_you when the human has to act; blocked only when nothing can move until another workspace or another person acts (a child workspace still running, a peer's code review), not for CI, builds, deploys or your own subagents, which are working; done once nothing is left for you or the human, so next is empty. Finished work that waits on the human to test, review or merge it is waiting_on_you, not done. When blocked, list what blocks you in blockedBy: {kind, ref, reason?} with kind pr (ref "owner/repo#N" or URL), agent (agent id), workspace (workspace id), person (a name) or other.
- Messages starting with [status] are the human asking for an update: call status_set.`;

/** The title line, added below the goal line for agents created while the "Name chats from the status card" setting is on. */
const TITLE_LINE = `  - title: a few words naming what this chat is about, at most 60 characters ("Gift-card checkout"). If the chat has its own PR, end with it ("Gift-card checkout · PR 312"); a PR you only wait on isn't the chat's own. Send it on your first call and again when the chat's subject changes.`;
const GOAL_LINE = /^ {2}- goal: .*$/m;

/** The instructions for an agent that names its chat: INSTRUCTIONS with the title line. */
export const TITLED_INSTRUCTIONS = INSTRUCTIONS.replace(GOAL_LINE, (line) => `${line}\n${TITLE_LINE}`);

/** Parses every call: agents created while the setting was on send a title, the rest don't. */
const SetInput = StatusInputSchema;
/** The tool schema for agents that don't name their chat. */
const UntitledInput = StatusInputSchema.omit({ title: true });

/** What an agent in a background workspace gets back instead of a status card. */
export const BACKGROUND_SKIP =
  "Skipped: this workspace runs in the background (an automated run hidden from the sidebar), so nobody reads its status. Put what you have in your final reply. status_set works again once the human opens this chat.";

/** What a helper agent gets back if it calls status_set from a tool list fetched before helpers stopped getting it. */
export const HELPER_SKIP =
  "Skipped: another agent started you, and that agent reports status for the work. Put what you have in your final reply and don't call status_set again.";

const toolsWith = (input: z.ZodType) => [
  {
    name: "status_set",
    description: "Publish where your work stands (replaces your previous status). When blocked, name what blocks you in blockedBy. See the server instructions for when and how.",
    inputSchema: z.toJSONSchema(input, { io: "input" }),
  },
];
export const TOOLS = toolsWith(UntitledInput);
/** The tools for an agent that names its chat: status_set takes a title. */
export const TITLED_TOOLS = toolsWith(SetInput);

export const REFRESH_PROMPT =
  "[status] The human asked where things stand. Call status_set with your current status, then carry on with what you were doing, if anything.";

/** The Sync asks button: the card waits on the human, but no open ask of the agent's records what. */
export const SYNC_ASKS_PROMPT =
  "[status] Your status says you are waiting on the human, but no open ask of yours records what, so they have nothing to answer here. Run ask_list with scope mine. Create an ask for each thing still waiting on them that has none, and ask_update or ask_resolve the ones that are out of date. An ask in another workspace shows only there: don't copy it, and if everything you wait on lives elsewhere, set blocked on that workspace. Then call status_set with where things stand and reply in one line.";

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
    /**
     * Helpers (agents another agent started, by `paseo.parent-agent-id`) get no tool and no card: the agent that
     * started them reports status for the work. Their tool list comes empty, since the MCP server itself can't be
     * dropped (the create hook doesn't see labels).
     */
    private readonly isHelper: (agentId: string) => Promise<boolean> = async () => false,
    /** Names the agent's chat from its card's title (`setAutomaticTitle` in `server/chat-title.ts`); resolves to whether it landed. */
    private readonly nameChat: (agentId: string, title: string) => Promise<boolean> = async () => false,
    /**
     * The "Name chats from the status card" setting is on and the host can take the title. An agent's tools and
     * instructions are fixed when it is created, so turning it on reaches only agents created afterwards.
     */
    private readonly namesChats: () => Promise<boolean> = async () => false,
  ) {}

  async instructionsFor(agentId: string | null): Promise<{ instructions: string | undefined }> {
    if (await this.helper(agentId)) return { instructions: undefined };
    return { instructions: (await this.titles()) ? TITLED_INSTRUCTIONS : INSTRUCTIONS };
  }

  async toolsFor(agentId: string | null): Promise<{ tools: typeof TOOLS }> {
    if (await this.helper(agentId)) return { tools: [] };
    return { tools: (await this.titles()) ? TITLED_TOOLS : TOOLS };
  }

  /** A failed settings read names no chat. */
  private async titles(): Promise<boolean> {
    return this.namesChats().catch(() => false);
  }

  /** Unknown callers (Codex on hosts without its agent ID) and failed lookups keep the tool. */
  private async helper(agentId: string | null): Promise<boolean> {
    return agentId ? this.isHelper(agentId).catch(() => false) : false;
  }

  async callTool(agentId: string | null, name: string, args: unknown): Promise<ToolResult> {
    try {
      if (name !== "status_set") throw new Error(`Unknown tool ${name}`);
      if (!agentId) throw new Error("PASEO_AGENT_ID is not set for this agent, so the status has no owner");
      const workspaceId = await this.workspaceOf(agentId);
      if (!workspaceId) throw new Error(`Agent ${agentId} has no workspace`);
      if (await this.isBackground(workspaceId).catch(() => false)) return { text: BACKGROUND_SKIP };
      if (await this.helper(agentId)) return { text: HELPER_SKIP };
      const input = SetInput.parse(args);
      if (isDoneWithNext(input)) return { text: DONE_WITH_NEXT, isError: true };
      const status = this.store.set(workspaceId, agentId, input);
      // Turning the setting off stops agents created while it was on from naming their chat.
      if (input.title && (await this.titles())) {
        // A host that can't take the title (or refuses it) must not fail the card.
        await this.nameChat(agentId, input.title).catch((error) => console.error(`[status] could not name the chat of ${agentId}`, error));
      }
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

  /** Sync asks: like a refresh, with the prompt that has the agent record what its card waits on. */
  syncAsks(agentId: string): Promise<{ sent: boolean }> {
    return this.refresh(agentId, { prompt: SYNC_ASKS_PROMPT });
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
      if ((await hidden(targetWorkspace)) || (await this.helper(agentId))) continue;
      try {
        if (!(await this.refresh(agentId, { auto })).skipped) asked += 1;
      } catch (error) {
        console.error(`[status] could not refresh ${agentId}`, error);
      }
    }
    return { asked };
  }

  /** `origin`: who started the turn, from the host's `agent.turn.before`; else the timeline's user message says. */
  async turnEnded(agentId: string, timeline: readonly AgentTimelineItem[] = [], origin?: TurnOrigin): Promise<void> {
    await this.captureFromReply(agentId, timeline);
    const prompt = turnPrompt(timeline);
    const status = this.store.turnEnded(agentId, answersTurn(origin ? { ...prompt, origin } : prompt));
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
      const input = SetInput.parse(JSON.parse(raw));
      // No tool call to reject here: steps left at the end of a turn wait on the human.
      this.store.set(workspaceId, agentId, isDoneWithNext(input) ? { ...input, state: "waiting_on_you" } : input);
    } catch (error) {
      console.error(`[status] unreadable paseo-status block from ${agentId}`, error);
    }
  }

  /** Refresh requests for agents that have never published a status; in memory only. */
  private readonly pendingWithoutStatus = new Set<string>();
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
