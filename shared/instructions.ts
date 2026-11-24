/** Claude Code cuts MCP server instructions at this many characters and appends "… [truncated]". */
export const INSTRUCTIONS_LIMIT = 4096;

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

/** What agents get: the human's own rules when set, else the built-in ones. */
export function agentInstructions(customInstructions = ""): string {
  return customInstructions.trim() || INSTRUCTIONS;
}
