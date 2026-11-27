import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BlockerResolver, checksSummary, parsePullRequestRef, PR_CACHE_MS, type AgentFacts, type BlockerLookups, type PullRequestFacts, type PullRequestRef } from "../server/blockers";
import { StatusService, type Courier } from "../server/service";
import { StatusStore } from "../server/store";
import { overviewStatus, workspaceOverviewStatus, type BlockerView } from "../shared/status";

const IDLE = { running: false };
const RUNNING = { running: true };

const PR: PullRequestFacts = {
  number: 25,
  title: "Keep a blocked card blocked",
  url: "https://github.com/fullstackhouse/paseo-status/pull/25",
  state: "OPEN",
  isDraft: false,
  statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
};
const AGENTS: AgentFacts[] = [
  { id: "a1b2c3d4-1111", title: "Migrate the schema", workspaceId: "ws-db", status: "running" },
  { id: "a1b2ffff-2222", title: "Other", workspaceId: "ws-x", status: "idle" },
];

function lookups(overrides: Partial<BlockerLookups> = {}): BlockerLookups & { prCalls: PullRequestRef[] } {
  const prCalls: PullRequestRef[] = [];
  return {
    prCalls,
    pullRequest: async (ref) => {
      prCalls.push(ref);
      return PR;
    },
    agents: async () => AGENTS,
    workspace: async (id) => (id === "ws-db" ? { id, title: "Database migration" } : null),
    ...overrides,
  };
}

describe("blockers", () => {
  it("parses owner/repo#N and PR URLs, nothing else", () => {
    expect(parsePullRequestRef("fullstackhouse/paseo#42")).toEqual({ repo: "fullstackhouse/paseo", number: 42 });
    expect(parsePullRequestRef("https://github.com/a/b/pull/7")).toEqual({ url: "https://github.com/a/b/pull/7" });
    expect(parsePullRequestRef("#42")).toBeNull();
    expect(parsePullRequestRef("some PR")).toBeNull();
  });

  it("sums checks up: failing beats pending beats passing", () => {
    expect(checksSummary([])).toBeNull();
    expect(checksSummary([{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "COMPLETED", conclusion: "SKIPPED" }])).toBe("passing");
    expect(checksSummary([{ status: "IN_PROGRESS", conclusion: null }, { status: "COMPLETED", conclusion: "SUCCESS" }])).toBe("pending");
    expect(checksSummary([{ state: "PENDING" }, { status: "COMPLETED", conclusion: "FAILURE" }])).toBe("failing");
    expect(checksSummary([{ state: "ERROR" }])).toBe("failing");
  });

  it("shows a PR with its state, checks and tone, opening its URL", async () => {
    const resolver = new BlockerResolver(lookups());
    expect(await resolver.resolve([{ kind: "pr", ref: "fullstackhouse/paseo-status#25", reason: "needs review" }])).toEqual([
      { kind: "pr", label: "#25 Keep a blocked card blocked", detail: "open · checks passing · needs review", url: PR.url, tone: "muted" },
    ]);
    const failing = new BlockerResolver(lookups({ pullRequest: async () => ({ ...PR, statusCheckRollup: [{ conclusion: "FAILURE", status: "COMPLETED" }] }) }));
    expect((await failing.resolve([{ kind: "pr", ref: PR.url }]))[0]).toMatchObject({ detail: "open · checks failing", tone: "danger" });
    const draft = new BlockerResolver(lookups({ pullRequest: async () => ({ ...PR, isDraft: true, statusCheckRollup: [] }) }));
    expect((await draft.resolve([{ kind: "pr", ref: PR.url }]))[0]).toMatchObject({ detail: "draft", tone: "warning" });
    const merged = new BlockerResolver(lookups({ pullRequest: async () => ({ ...PR, state: "MERGED" }) }));
    expect((await merged.resolve([{ kind: "pr", ref: PR.url }]))[0]).toMatchObject({ detail: "merged", tone: "success" });
  });

  it("caches a PR lookup briefly, failures included", async () => {
    let now = 0;
    const deps = lookups();
    const resolver = new BlockerResolver(deps, () => now);
    await resolver.resolve([{ kind: "pr", ref: "a/b#1" }]);
    await resolver.resolve([{ kind: "pr", ref: "a/b#1" }]);
    expect(deps.prCalls).toHaveLength(1);
    now += PR_CACHE_MS;
    await resolver.resolve([{ kind: "pr", ref: "a/b#1" }]);
    expect(deps.prCalls).toHaveLength(2);
  });

  it("falls back to the raw ref when gh can't tell", async () => {
    const resolver = new BlockerResolver(lookups({ pullRequest: async () => null }));
    expect(await resolver.resolve([{ kind: "pr", ref: "https://github.com/a/b/pull/9" }, { kind: "pr", ref: "a/b#3", reason: "waiting" }])).toEqual([
      { kind: "pr", label: "https://github.com/a/b/pull/9", url: "https://github.com/a/b/pull/9" },
      { kind: "pr", label: "a/b#3", detail: "waiting" },
    ]);
    const throwing = new BlockerResolver(lookups({ pullRequest: async () => Promise.reject(new Error("no gh")) }));
    expect(await throwing.resolve([{ kind: "pr", ref: "a/b#3" }])).toEqual([{ kind: "pr", label: "a/b#3" }]);
  });

  it("names an agent by full id or unique prefix, with its workspace", async () => {
    const resolver = new BlockerResolver(lookups());
    expect(await resolver.resolve([{ kind: "agent", ref: "a1b2c3", reason: "migration first" }])).toEqual([
      { kind: "agent", label: "Migrate the schema", detail: "running · migration first", agentId: "a1b2c3d4-1111", workspaceId: "ws-db" },
    ]);
    // Ambiguous prefix: shown as written.
    expect(await resolver.resolve([{ kind: "agent", ref: "a1b2" }])).toEqual([{ kind: "agent", label: "a1b2" }]);
  });

  it("names a workspace by its title; people and other things as written", async () => {
    const resolver = new BlockerResolver(lookups());
    expect(
      await resolver.resolve([
        { kind: "workspace", ref: "ws-db" },
        { kind: "workspace", ref: "ws-gone" },
        { kind: "person", ref: "Mo", reason: "design sign-off" },
        { kind: "other", ref: "Vendor API access" },
      ]),
    ).toEqual([
      { kind: "workspace", label: "Database migration", workspaceId: "ws-db" },
      { kind: "workspace", label: "ws-gone" },
      { kind: "person", label: "Mo", detail: "design sign-off" },
      { kind: "other", label: "Vendor API access" },
    ]);
  });
});

describe("blockedBy on the card", () => {
  const courier: Courier = { state: async () => "idle", send: async () => undefined };
  const base = { tldr: "Waiting on the schema migration.", done: [], next: [] };
  const view: BlockerView[] = [{ kind: "pr", label: "#25 Keep a blocked card blocked", detail: "open", url: PR.url }];

  it("is stored with the card, replaced on each call, and dropped when empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "status-"));
    const store = new StatusStore(dir);
    const service = new StatusService(store, courier, async () => "ws");
    await service.callTool("agent", "status_set", { ...base, state: "blocked", blockedBy: [{ kind: "pr", ref: "a/b#1" }] });
    expect(new StatusStore(dir).get("agent")?.blockedBy).toEqual([{ kind: "pr", ref: "a/b#1" }]);
    await service.callTool("agent", "status_set", { ...base, state: "blocked", blockedBy: [] });
    expect(store.get("agent")?.blockedBy).toBeUndefined();
  });

  it("rejects an unknown kind", async () => {
    const service = new StatusService(new StatusStore(mkdtempSync(join(tmpdir(), "status-"))), courier, async () => "ws");
    const result = await service.callTool("agent", "status_set", { ...base, state: "blocked", blockedBy: [{ kind: "ticket", ref: "X-1" }] });
    expect(result.isError).toBe(true);
  });

  it("reaches the Overview only while the card is blocked", () => {
    const card = { agentId: "agent", workspaceId: "ws", ...base, updatedAt: "2026-11-21T10:00:00.000Z", turnsSince: 0 };
    expect(overviewStatus({ ...card, state: "blocked" }, IDLE, view).blockedBy).toEqual(view);
    expect(overviewStatus({ ...card, state: "working" }, IDLE, view).blockedBy).toBeUndefined();
    expect(overviewStatus({ ...card, state: "blocked" }, IDLE, []).blockedBy).toBeUndefined();
    expect(workspaceOverviewStatus([{ ...card, state: "blocked" }], () => IDLE, { agent: view })?.blockedBy).toEqual(view);
  });
});
