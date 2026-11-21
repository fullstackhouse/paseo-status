import { execFile } from "node:child_process";
import type { Blocker, BlockerView } from "../shared/status";

/** What `gh pr view --json state,isDraft,title,statusCheckRollup,url,number` returns, as far as this reads it. */
export interface PullRequestFacts {
  number?: number;
  title: string;
  url: string;
  state: string;
  isDraft?: boolean;
  statusCheckRollup?: { status?: string; conclusion?: string | null; state?: string }[] | null;
}

export interface AgentFacts {
  id: string;
  title: string | null;
  workspaceId: string | null;
  status: string;
}

export interface WorkspaceFacts {
  id: string;
  title: string | null;
}

/** Lookups the resolver needs; each returns null when the thing is not found or the lookup fails. */
export interface BlockerLookups {
  pullRequest(ref: PullRequestRef): Promise<PullRequestFacts | null>;
  /** Every non-archived agent on the host, background workspaces included. */
  agents(): Promise<readonly AgentFacts[]>;
  workspace(id: string): Promise<WorkspaceFacts | null>;
}

export type PullRequestRef = { url: string } | { repo: string; number: number };

const SHORT_REF = /^([\w.-]+\/[\w.-]+)#(\d+)$/;
const PR_URL = /^https?:\/\/[^/]+\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/;

/** `owner/repo#N` or a PR URL; null for anything else. */
export function parsePullRequestRef(ref: string): PullRequestRef | null {
  const short = SHORT_REF.exec(ref.trim());
  if (short) return { repo: short[1]!, number: Number(short[2]) };
  return PR_URL.test(ref.trim()) ? { url: ref.trim() } : null;
}

const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const PENDING = new Set(["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"]);

/** Checks as one word: failing beats pending beats passing; null without checks. */
export function checksSummary(rollup: PullRequestFacts["statusCheckRollup"]): "failing" | "pending" | "passing" | null {
  if (!rollup || rollup.length === 0) return null;
  let pending = false;
  for (const check of rollup) {
    const result = check.conclusion || check.state || "";
    if (FAILED.has(result)) return "failing";
    if (PENDING.has(result) || (check.status && check.status !== "COMPLETED") || !result) pending = true;
  }
  return pending ? "pending" : "passing";
}

export function pullRequestView(blocker: Blocker, pr: PullRequestFacts): BlockerView {
  const state = pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : pr.isDraft ? "draft" : "open";
  const checks = state === "open" || state === "draft" ? checksSummary(pr.statusCheckRollup) : null;
  const tone: BlockerView["tone"] =
    state === "merged" ? "success" : checks === "failing" ? "danger" : state === "draft" || checks === "pending" ? "warning" : "muted";
  const number = pr.number ?? Number(/\/pull\/(\d+)/.exec(pr.url)?.[1] ?? NaN);
  return {
    kind: "pr",
    label: Number.isFinite(number) ? `#${number} ${pr.title}` : pr.title,
    detail: join(state, checks && `checks ${checks}`, blocker.reason),
    url: pr.url,
    tone,
  };
}

/** An agent named by its full id or a unique prefix of it. */
export function findAgent(agents: readonly AgentFacts[], ref: string): AgentFacts | null {
  const exact = agents.find((agent) => agent.id === ref);
  if (exact) return exact;
  const matches = agents.filter((agent) => agent.id.startsWith(ref));
  return matches.length === 1 ? matches[0]! : null;
}

function join(...parts: (string | null | undefined | false)[]): string | undefined {
  const text = parts.filter((part): part is string => !!part && !!part.trim()).join(" · ");
  return text || undefined;
}

/** The raw ref, for anything that can't be looked up. */
function fallback(blocker: Blocker): BlockerView {
  const url = blocker.kind === "pr" && /^https?:\/\//.test(blocker.ref) ? blocker.ref : undefined;
  return { kind: blocker.kind, label: blocker.ref, ...(join(blocker.reason) ? { detail: join(blocker.reason) } : {}), ...(url ? { url } : {}) };
}

/** How long a PR lookup (or its failure) is reused: the Overview polls every few seconds. */
export const PR_CACHE_MS = 60_000;

/**
 * Turns the blockers an agent named into rows to show: PR state and checks from `gh`, agent and
 * workspace titles from the daemon. Anything that can't be found shows as the agent wrote it.
 */
export class BlockerResolver {
  private readonly prs = new Map<string, { at: number; value: Promise<PullRequestFacts | null> }>();

  constructor(
    private readonly lookups: BlockerLookups,
    private readonly now: () => number = Date.now,
  ) {}

  async resolve(blockers: readonly Blocker[]): Promise<BlockerView[]> {
    const needAgents = blockers.some((blocker) => blocker.kind === "agent");
    const agents = needAgents
      ? this.lookups.agents().catch((error) => {
          console.error("[status] could not list agents for blockers", error);
          return [] as AgentFacts[];
        })
      : Promise.resolve([]);
    return Promise.all(blockers.map((blocker) => this.one(blocker, agents).catch(() => fallback(blocker))));
  }

  private async one(blocker: Blocker, agents: Promise<readonly AgentFacts[]>): Promise<BlockerView> {
    switch (blocker.kind) {
      case "pr": {
        const ref = parsePullRequestRef(blocker.ref);
        const pr = ref && (await this.pullRequest(ref));
        return pr ? pullRequestView(blocker, pr) : fallback(blocker);
      }
      case "agent": {
        const agent = findAgent(await agents, blocker.ref);
        if (!agent) return fallback(blocker);
        return {
          kind: "agent",
          label: agent.title || agent.id,
          detail: join(agent.status, blocker.reason),
          agentId: agent.id,
          ...(agent.workspaceId ? { workspaceId: agent.workspaceId } : {}),
        };
      }
      case "workspace": {
        const workspace = await this.lookups.workspace(blocker.ref);
        if (!workspace) return fallback(blocker);
        return { kind: "workspace", label: workspace.title || workspace.id, ...(blocker.reason ? { detail: blocker.reason } : {}), workspaceId: workspace.id };
      }
      default:
        return fallback(blocker);
    }
  }

  private pullRequest(ref: PullRequestRef): Promise<PullRequestFacts | null> {
    const key = "url" in ref ? ref.url : `${ref.repo}#${ref.number}`;
    const cached = this.prs.get(key);
    if (cached && this.now() - cached.at < PR_CACHE_MS) return cached.value;
    const value = this.lookups.pullRequest(ref).catch(() => null);
    this.prs.set(key, { at: this.now(), value });
    return value;
  }
}

/** `gh pr view` for one PR; null when gh is missing, unauthenticated, or the PR is not found. */
export function ghPullRequest(ref: PullRequestRef): Promise<PullRequestFacts | null> {
  const args = ["pr", "view", ...("url" in ref ? [ref.url] : [String(ref.number), "--repo", ref.repo]), "--json", "number,state,isDraft,title,statusCheckRollup,url"];
  return new Promise((resolve) => {
    execFile("gh", args, { timeout: 10_000 }, (error, stdout) => {
      if (error) return resolve(null);
      try {
        resolve(JSON.parse(stdout) as PullRequestFacts);
      } catch {
        resolve(null);
      }
    });
  });
}
