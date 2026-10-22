import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { FALLBACK_PROMPT, readOpenAskCounts, readWaiting, REFRESH_PROMPT, StatusService, type AgentState, type Courier } from "../server/service";
import { StatusStore } from "../server/store";
import { needsYou, summarize, type Status } from "../shared/status";

class FakeCourier implements Courier {
  states = new Map<string, AgentState>();
  sent: { agentId: string; text: string }[] = [];
  async state(agentId: string) {
    return this.states.get(agentId) ?? "idle";
  }
  async send(agentId: string, text: string) {
    this.sent.push({ agentId, text });
  }
}

const WS = "wks_1";
const AGENT = "agent-1";
const status = { state: "working", tldr: "Adding a gift-card checkout to the demo shop; tests pass.", done: ["unit tests: 42/42"], next: ["commit and push"] };

describe("status", () => {
  let dir: string;
  let store: StatusStore;
  let courier: FakeCourier;
  let service: StatusService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "status-"));
    store = new StatusStore(dir);
    courier = new FakeCourier();
    service = new StatusService(store, courier, async (agentId) => (agentId === AGENT ? WS : null));
  });

  it("publishes one status per agent, replaced on each call, and persists it", async () => {
    expect((await service.callTool(AGENT, "status_set", status)).isError).toBeFalsy();
    await service.callTool(AGENT, "status_set", { ...status, state: "done", tldr: "Shipped." });
    const reloaded = new StatusStore(dir).list(WS);
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]).toMatchObject({ agentId: AGENT, state: "done", tldr: "Shipped.", turnsSince: 0 });
  });

  it("rejects calls without an agent identity or with a bad payload", async () => {
    expect((await service.callTool(null, "status_set", status)).isError).toBe(true);
    expect((await service.callTool(AGENT, "status_set", { ...status, state: "sleeping" })).isError).toBe(true);
    expect(store.list(WS)).toHaveLength(0);
  });

  it("counts turns that end without an update, and resets on the next one", async () => {
    await service.callTool(AGENT, "status_set", status);
    await service.turnEnded(AGENT); // the turn that set it
    expect(store.get(AGENT)?.turnsSince).toBe(0);
    await service.turnEnded(AGENT);
    await service.turnEnded(AGENT);
    expect(store.get(AGENT)?.turnsSince).toBe(2);
    await service.callTool(AGENT, "status_set", status);
    expect(store.get(AGENT)?.turnsSince).toBe(0);
  });

  it("sends a refresh at once to an idle agent", async () => {
    expect(await service.refresh(AGENT)).toEqual({ sent: true });
    expect(courier.sent).toEqual([{ agentId: AGENT, text: REFRESH_PROMPT }]);
  });

  it("holds a refresh for a running agent until its turn ends, then sends it once", async () => {
    await service.callTool(AGENT, "status_set", status);
    await service.turnEnded(AGENT);
    courier.states.set(AGENT, "running");
    expect(await service.refresh(AGENT)).toEqual({ sent: false });
    expect(courier.sent).toHaveLength(0);
    expect(store.get(AGENT)?.refreshPending).toBe(true);
    courier.states.set(AGENT, "idle");
    await service.turnEnded(AGENT);
    await service.turnEnded(AGENT);
    expect(courier.sent).toHaveLength(1);
    expect(store.get(AGENT)?.refreshPending).toBe(false);
  });

  it("drops a held refresh when the agent updated its status during that turn", async () => {
    await service.callTool(AGENT, "status_set", status);
    await service.turnEnded(AGENT);
    courier.states.set(AGENT, "running");
    await service.refresh(AGENT);
    await service.callTool(AGENT, "status_set", status);
    await service.turnEnded(AGENT);
    expect(courier.sent).toHaveLength(0);
    expect(store.get(AGENT)?.refreshPending).toBe(false);
  });

  it("holds a refresh for a running agent that never published a status", async () => {
    courier.states.set(AGENT, "running");
    await service.refresh(AGENT);
    await service.turnEnded(AGENT);
    expect(courier.sent).toHaveLength(1);
  });

  it("refuses to refresh an archived agent and hides its card", async () => {
    await service.callTool(AGENT, "status_set", status);
    courier.states.set(AGENT, "gone");
    await expect(service.refresh(AGENT)).rejects.toThrow(/archived/);
    store.patch(AGENT, { archived: true });
    expect(store.list(WS)).toHaveLength(0);
  });

  it("the panel opening asks stale cards only, and only once per update", async () => {
    await service.callTool(AGENT, "status_set", status);
    await service.turnEnded(AGENT);
    await service.turnEnded(AGENT); // 1 turn behind: not stale yet
    expect(await service.refreshAll(WS, { auto: true })).toEqual({ asked: 0 });
    await service.turnEnded(AGENT); // 2 behind: stale
    expect(await service.refreshAll(WS, { auto: true })).toEqual({ asked: 1 });
    // The agent ignored it and did more turns: reopening the panel does not nag again.
    await service.turnEnded(AGENT);
    expect(await service.refreshAll(WS, { auto: true })).toEqual({ asked: 0 });
    // Once it updates and falls behind again, the next opening asks again.
    await service.callTool(AGENT, "status_set", status);
    for (let turn = 0; turn < 3; turn++) await service.turnEnded(AGENT);
    expect(await service.refreshAll(WS, { auto: true })).toEqual({ asked: 1 });
    expect(courier.sent).toHaveLength(2);
  });

  it("the Refresh button asks every card that missed a turn, plus agents with no card", async () => {
    await service.callTool(AGENT, "status_set", status);
    await service.turnEnded(AGENT);
    expect(await service.refreshAll(WS, { silent: ["agent-2"] })).toEqual({ asked: 1 });
    await service.turnEnded(AGENT);
    expect(await service.refreshAll(WS, { silent: ["agent-2"] })).toEqual({ asked: 2 });
  });

  it("asks agents without the tool for a paseo-status block, and reads it from their reply", async () => {
    const legacy = new StatusService(store, courier, async () => WS, (agentId) => agentId !== "old-agent");
    await legacy.refresh("old-agent");
    expect(courier.sent[0]).toEqual({ agentId: "old-agent", text: FALLBACK_PROMPT });
    const block = JSON.stringify({ state: "blocked", tldr: "Waiting on API keys.", done: [], next: ["Get keys"] });
    await legacy.turnEnded("old-agent", [
      { type: "user_message", text: FALLBACK_PROMPT },
      { type: "assistant_message", text: "Here you go.\n```paseo-status\n" },
      { type: "assistant_message", text: `${block}\n\`\`\`` },
    ] as any);
    expect(store.get("old-agent")).toMatchObject({ state: "blocked", tldr: "Waiting on API keys.", turnsSince: 0 });
  });

  it("ignores an unreadable paseo-status block", async () => {
    await service.turnEnded(AGENT, [{ type: "assistant_message", text: "```paseo-status\n{nope\n```" }] as any);
    expect(store.get(AGENT)).toBeUndefined();
  });

  it("reads open asks from the asks plugin's store, when present", () => {
    const asksDir = join(dir, "asks");
    mkdirSync(join(asksDir, "workspaces"), { recursive: true });
    writeFileSync(
      join(asksDir, "workspaces", `${WS}.json`),
      JSON.stringify({
        nextId: 3,
        asks: [
          { id: "A1", title: "Merge PR #7?", ownerAgentId: AGENT, status: "open" },
          { id: "A2", title: "Call it store credit?", ownerAgentId: AGENT, status: "done" },
        ],
      }),
    );
    expect(readWaiting(asksDir, [WS, "wks_missing"])).toEqual([{ id: "A1", title: "Merge PR #7?", agentId: AGENT }]);
  });

  it("a card waiting on the human stops needing them once a turn starts after it", async () => {
    await service.callTool(AGENT, "status_set", { ...status, state: "waiting_on_you" });
    expect(needsYou(store.get(AGENT)!, true)).toBe(true); // set during the turn still running
    await service.turnEnded(AGENT);
    expect(needsYou(store.get(AGENT)!, false)).toBe(true);
    expect(needsYou(store.get(AGENT)!, true)).toBe(false); // the human replied; the agent is running
    await service.turnEnded(AGENT);
    expect(needsYou(store.get(AGENT)!, false)).toBe(false); // that turn ended without a new status
    await service.callTool(AGENT, "status_set", { ...status, state: "blocked" });
    expect(needsYou(store.get(AGENT)!, false)).toBe(true);
  });
});

describe("summarize", () => {
  const card = (workspaceId: string, agentId: string, state: Status["state"], turnsSince = 0): Status => ({
    agentId,
    workspaceId,
    state,
    tldr: "t",
    done: [],
    next: [],
    updatedAt: "2026-10-22T00:00:00Z",
    turnsSince,
  });

  it("ranks needs you over working over done", () => {
    const result = summarize({
      statuses: [card("ws-a", "a1", "done"), card("ws-b", "b1", "working"), card("ws-c", "c1", "waiting_on_you"), card("ws-c", "c2", "working")],
      openAsks: {},
      agents: [],
      running: () => false,
    });
    expect(result).toEqual({
      "ws-a": { state: "done", waiting: 0 },
      "ws-b": { state: "working", waiting: 0 },
      "ws-c": { state: "needs_you", waiting: 1 },
    });
  });

  it("counts open asks as needing you, even when every card says done", () => {
    const result = summarize({ statuses: [card("ws-a", "a1", "done")], openAsks: { "ws-a": 2, "ws-b": 0 }, agents: [], running: () => false });
    expect(result).toEqual({ "ws-a": { state: "needs_you", waiting: 2 } });
  });

  it("treats a running agent as working and an answered card as no longer waiting", () => {
    const result = summarize({
      statuses: [card("ws-a", "a1", "waiting_on_you", 1)],
      openAsks: {},
      agents: [{ workspaceId: "ws-a", running: true }, { workspaceId: "ws-b", running: false }],
      running: () => true,
    });
    expect(result).toEqual({ "ws-a": { state: "working", waiting: 0 }, "ws-b": { state: "done", waiting: 0 } });
  });
});

describe("readOpenAskCounts", () => {
  it("counts open asks per workspace file and ignores closed ones", () => {
    const asksDir = mkdtempSync(join(tmpdir(), "asks-"));
    mkdirSync(join(asksDir, "workspaces"));
    writeFileSync(
      join(asksDir, "workspaces", `${encodeURIComponent("wks/1")}.json`),
      JSON.stringify({ asks: [{ status: "open" }, { status: "done" }, { status: "open" }, { status: "in_progress" }] }),
    );
    writeFileSync(join(asksDir, "workspaces", "wks_2.json"), JSON.stringify({ asks: [{ status: "dropped" }] }));
    expect(readOpenAskCounts(asksDir)).toEqual({ "wks/1": 2 });
    expect(readOpenAskCounts(join(asksDir, "missing"))).toEqual({});
  });
});
