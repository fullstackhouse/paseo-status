import type { PaseoApi } from "@getpaseo/client";
import type { Blocker } from "../shared/status";
import { parsePullRequestRef } from "./blockers";

/** The host's cap on a chat title (`MAX_EXPLICIT_AGENT_TITLE_CHARS` in Paseo's protocol). */
export const HOST_TITLE_MAX = 200;

// COMPAT(statusCardTitles): FSH hosts give agent handles `setAutomaticTitle` (`features.statusCardTitles`,
// fullstackhouse/paseo#299); the npm SDK doesn't type it. Older hosts lack the method, so no chat is named there.
interface AutomaticTitler {
  setAutomaticTitle?(title: string, requestId?: string): Promise<{ applied: boolean }>;
}

/**
 * Names the agent's chat from its status card. Returns whether the title landed: the host skips it while its
 * "From the status card" chat titles setting is off or after the chat was renamed by hand.
 */
export async function setAutomaticTitle(api: PaseoApi, agentId: string, title: string): Promise<boolean> {
  const handle = api.agents.ref(agentId) as unknown as AutomaticTitler;
  if (typeof handle.setAutomaticTitle !== "function") return false;
  return (await handle.setAutomaticTitle(title)).applied;
}

/** The title to send: the agent's, plus " · PR N" when the card links exactly one PR and that still fits the host. */
export function chatTitle(title: string, blockedBy: readonly Blocker[] = []): string {
  const prs = new Map<string, number>();
  for (const blocker of blockedBy) {
    const pr = blocker.kind === "pr" ? pullRequestOf(blocker.ref) : null;
    if (pr) prs.set(`${pr.repo}#${pr.number}`, pr.number);
  }
  if (prs.size !== 1) return title;
  const withPr = `${title} · PR ${[...prs.values()][0]}`;
  return withPr.length <= HOST_TITLE_MAX ? withPr : title;
}

function pullRequestOf(ref: string): { repo: string; number: number } | null {
  const parsed = parsePullRequestRef(ref);
  if (!parsed || "number" in parsed) return parsed;
  const url = /\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(parsed.url);
  return url ? { repo: url[1]!, number: Number(url[2]) } : null;
}
