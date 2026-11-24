import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { BACKGROUND_SKIP, FALLBACK_PROMPT, HELPER_SKIP, INSTRUCTIONS, readOpenAskOwners, readWaiting, REFRESH_PROMPT, StatusService, TOOLS, WAKE_PROMPT, type AgentState, type Courier } from "../server/service";
import { StatusStore } from "../server/store";
import { isAnswered, needsYou, stateTone, needsYouSince, overviewStatus, rowBadgeLabel, workspaceOverviewStatus, summarize, workspaceWorkState, type Status } from "../shared/status";

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

  it("keeps the goal across updates that leave it out, and clears it on an empty one", async () => {
    await service.callTool(AGENT, "status_set", { ...status, goal: "Ship gift cards as 3 PRs; 1 merged." });
    await service.callTool(AGENT, "status_set", { ...status, tldr: "Second PR open." });
    expect(new StatusStore(dir).get(AGENT)).toMatchObject({ goal: "Ship gift cards as 3 PRs; 1 merged.", tldr: "Second PR open." });
    await service.callTool(AGENT, "status_set", { ...status, goal: "Ship gift cards as 3 PRs; 2 merged." });
    expect(store.get(AGENT)?.goal).toBe("Ship gift cards as 3 PRs; 2 merged.");
    await service.callTool(AGENT, "status_set", { ...status, goal: " " });
    expect(store.get(AGENT)?.goal).toBeUndefined();
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

  it("steers a refresh into a running turn when the provider can take it", async () => {
    await service.callTool(AGENT, "status_set", status);
    await service.turnEnded(AGENT);
    courier.states.set(AGENT, "steerable");
    expect(await service.refresh(AGENT)).toEqual({ sent: true });
    expect(courier.sent).toEqual([{ agentId: AGENT, text: REFRESH_PROMPT }]);
    expect(store.get(AGENT)?.refreshPending).toBeFalsy();
    await service.turnEnded(AGENT);
    expect(courier.sent).toHaveLength(1);
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

  it("publishes no card for an agent in a background workspace, and tells it so", async () => {
    let background = true;
    const scoped = new StatusService(store, courier, async () => WS, () => true, undefined, async () => background);
    expect(await scoped.callTool(AGENT, "status_set", status)).toEqual({ text: BACKGROUND_SKIP });
    expect(store.get(AGENT)).toBeFalsy();
    // The human opened the run's chat, so it isn't background any more.
    background = false;
    expect((await scoped.callTool(AGENT, "status_set", status)).text).toBe("Status published (working).");
  });

  describe("a helper agent (started by another agent)", () => {
    const HELPER = "helper-1";
    let scoped: StatusService;
    beforeEach(() => {
      scoped = new StatusService(store, courier, async () => WS, () => true, undefined, undefined, async (agentId) => agentId === HELPER);
    });

    it("gets no tool or instructions, while other agents and unknown callers keep them", async () => {
      expect(await scoped.toolsFor(HELPER)).toEqual({ tools: [] });
      expect(await scoped.instructionsFor(HELPER)).toEqual({ instructions: undefined });
      expect(await scoped.toolsFor(AGENT)).toEqual({ tools: TOOLS });
      expect(await scoped.instructionsFor(null)).toEqual({ instructions: INSTRUCTIONS });
    });

    it("publishes no card when it calls status_set anyway, and says why", async () => {
      expect(await scoped.callTool(HELPER, "status_set", status)).toEqual({ text: HELPER_SKIP });
      expect(store.get(HELPER)).toBeFalsy();
    });

    it("is left out of Refresh all, cards from before included", async () => {
      store.set(WS, HELPER, { ...status, state: "working" });
      await scoped.callTool(AGENT, "status_set", status);
      for (let turn = 0; turn < 2; turn++) {
        await scoped.turnEnded(AGENT);
        await scoped.turnEnded(HELPER);
      }
      expect(await scoped.refreshAll(WS, { silent: [HELPER] })).toEqual({ asked: 1 });
      expect(courier.sent.map((sent) => sent.agentId)).toEqual([AGENT]);
    });
  });

  it("Refresh all leaves out agents in background workspaces", async () => {
    const hiddenWs = "wks_hidden";
    const scoped = new StatusService(
      store,
      courier,
      async (agentId) => (agentId === "bg-agent" ? hiddenWs : WS),
      () => true,
      undefined,
      async (workspaceId) => workspaceId === hiddenWs,
    );
    await scoped.callTool(AGENT, "status_set", status);
    // A card left from before background workspaces stopped getting them.
    store.set(hiddenWs, "bg-agent", { ...status, state: "working" });
    for (let turn = 0; turn < 3; turn++) {
      await scoped.turnEnded(AGENT);
      await scoped.turnEnded("bg-agent");
    }
    expect(await scoped.refreshAll(undefined, { auto: true })).toEqual({ asked: 1 });
    expect(await scoped.refreshAll(hiddenWs, { silent: ["agent-3"] })).toEqual({ asked: 0 });
    expect(courier.sent.map((sent) => sent.agentId)).toEqual([AGENT]);
    // Asking one agent directly is the human's own request, so it still goes through.
    await scoped.refresh("bg-agent");
    expect(courier.sent.map((sent) => sent.agentId)).toEqual([AGENT, "bg-agent"]);
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
    await service.callTool(AGENT, "status_set", { ...status, state: "waiting_on_you" });
    expect(needsYou(store.get(AGENT)!, false)).toBe(true);
  });

  it("a blocked card never needs the human and stays unanswered across later turns", async () => {
    await service.callTool(AGENT, "status_set", { ...status, state: "blocked" });
    expect(needsYou(store.get(AGENT)!, false)).toBe(false);
    expect(isAnswered(store.get(AGENT)!, false)).toBe(false);
    await service.turnEnded(AGENT);
    expect(isAnswered(store.get(AGENT)!, false)).toBe(false);
    expect(isAnswered(store.get(AGENT)!, true)).toBe(false);
  });
});

describe("wake", () => {
  it("prompts an idle agent to check its children, and holds a plain refresh for a running one", async () => {
    const store = new StatusStore(mkdtempSync(join(tmpdir(), "status-")));
    const courier = new FakeCourier();
    const service = new StatusService(store, courier, async () => WS);
    await service.callTool(AGENT, "status_set", status);
    await service.turnEnded(AGENT);
    expect(await service.wake(AGENT)).toEqual({ sent: true });
    expect(courier.sent).toEqual([{ agentId: AGENT, text: WAKE_PROMPT }]);

    courier.states.set(AGENT, "running");
    expect(await service.wake(AGENT)).toEqual({ sent: false });
    courier.states.set(AGENT, "idle");
    await service.turnEnded(AGENT);
    expect(courier.sent.at(-1)).toEqual({ agentId: AGENT, text: REFRESH_PROMPT });
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
    const result = summarize({ statuses: [card("ws-a", "a1", "done")], openAsks: { "ws-a": ["x1", "x2"], "ws-b": [] }, agents: [], running: () => false });
    expect(result).toEqual({ "ws-a": { state: "needs_you", waiting: 2 } });
  });

  it("counts a waiting card once when its agent's open asks already say what it needs", () => {
    const result = summarize({
      statuses: [card("ws-a", "a1", "blocked"), card("ws-a", "a2", "waiting_on_you")],
      openAsks: { "ws-a": ["a1"] },
      agents: [],
      running: () => false,
    });
    expect(result).toEqual({ "ws-a": { state: "needs_you", waiting: 2 } });
  });

  it("never counts a blocked card as needing you", () => {
    const result = summarize({ statuses: [card("ws-a", "a1", "blocked")], openAsks: {}, agents: [], running: () => false });
    expect(result).toEqual({ "ws-a": { state: "done", waiting: 0 } });
    expect(rowBadgeLabel(result["ws-a"])).toBeNull();
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

describe("rowBadgeLabel", () => {
  it("shows a badge only when the workspace needs you", () => {
    expect(rowBadgeLabel(undefined)).toBeNull();
    expect(rowBadgeLabel({ state: "working", waiting: 0 })).toBeNull();
    expect(rowBadgeLabel({ state: "done", waiting: 0 })).toBeNull();
    expect(rowBadgeLabel({ state: "needs_you", waiting: 1 })).toBe("needs you");
    expect(rowBadgeLabel({ state: "needs_you", waiting: 6 })).toBe("needs you (6)");
  });
});

describe("stateTone", () => {
  const card = (state: Status["state"]): Status => ({ agentId: AGENT, workspaceId: WS, state, tldr: "t", done: [], next: [], updatedAt: "2026-11-20T00:00:00Z", turnsSince: 0 });

  it("reads a blocked card calm", () => {
    expect(stateTone(card("blocked"), false)).toBe("muted");
  });

  it("keeps the other states as they were", () => {
    expect(stateTone(card("waiting_on_you"), false)).toBe("warn");
    expect(stateTone(card("done"), false)).toBe("good");
    expect(stateTone(card("working"), false)).toBe("muted");
    expect(stateTone(card("waiting_on_you"), true)).toBe("muted");
  });
});

describe("overviewStatus", () => {
  const card = (fields: Partial<Status>): Status => ({
    agentId: AGENT,
    workspaceId: WS,
    state: "waiting_on_you",
    tldr: "Spec ready",
    now: "Waiting on your review",
    done: ["drafted"],
    next: ["merge"],
    updatedAt: "2026-11-12T10:00:00Z",
    turnsSince: 0,
    ...fields,
  });

  it("maps a card to the Overview's status shape", () => {
    expect(overviewStatus(card({}), false)).toEqual({
      state: "waiting_on_you",
      summary: "Spec ready",
      now: "Waiting on your review",
      updatedAt: Date.parse("2026-11-12T10:00:00Z"),
    });
    expect(overviewStatus(card({ state: "working", now: undefined }), true)).not.toHaveProperty("now");
    expect(overviewStatus(card({ goal: "Ship the spec" }), false).goal).toBe("Ship the spec");
  });

  it("shows the workspace's newest card with the newest goal any agent set", () => {
    const lead = card({ agentId: "lead", goal: "Ship gift cards as 3 PRs; 1 merged.", updatedAt: "2026-11-12T10:00:00Z" });
    const helper = card({ agentId: "helper", tldr: "Tests pass", updatedAt: "2026-11-12T11:00:00Z" });
    expect(workspaceOverviewStatus([lead, helper], () => false)).toMatchObject({ summary: "Tests pass", goal: "Ship gift cards as 3 PRs; 1 merged." });
    expect(workspaceOverviewStatus([helper], () => false)).not.toHaveProperty("goal");
    expect(workspaceOverviewStatus([], () => false)).toBeNull();
  });

  it("marks a waiting card answered once a turn started after it", () => {
    expect(isAnswered(card({}), false)).toBe(false);
    expect(overviewStatus(card({ turnsSince: 1 }), false).answered).toBe(true);
    expect(overviewStatus(card({}), true).answered).toBe(true); // the human replied; the agent is running
    expect(overviewStatus(card({ setThisTurn: true }), true)).not.toHaveProperty("answered");
    expect(overviewStatus(card({ state: "working", turnsSince: 3 }), false)).not.toHaveProperty("answered");
    expect(overviewStatus(card({ state: "done", turnsSince: 3 }), false)).not.toHaveProperty("answered");
  });

  it("never marks a blocked card answered", () => {
    expect(isAnswered(card({ state: "blocked", turnsSince: 1 }), false)).toBe(false);
    expect(overviewStatus(card({ state: "blocked", turnsSince: 1 }), false)).not.toHaveProperty("answered");
    expect(workspaceOverviewStatus([card({ state: "blocked", turnsSince: 1 })], () => true)).not.toHaveProperty("answered");
  });
});

describe("readOpenAskOwners", () => {
  it("lists each open ask's owner per workspace file and ignores closed ones", () => {
    const asksDir = mkdtempSync(join(tmpdir(), "asks-"));
    mkdirSync(join(asksDir, "workspaces"));
    writeFileSync(
      join(asksDir, "workspaces", `${encodeURIComponent("wks/1")}.json`),
      JSON.stringify({
        asks: [
          { status: "open", ownerAgentId: "a1" },
          { status: "done", ownerAgentId: "a1" },
          { status: "open", ownerAgentId: "a2" },
          { status: "in_progress", ownerAgentId: "a2" },
        ],
      }),
    );
    writeFileSync(join(asksDir, "workspaces", "wks_2.json"), JSON.stringify({ asks: [{ status: "dropped" }] }));
    expect(readOpenAskOwners(asksDir)).toEqual({ "wks/1": ["a1", "a2"] });
    expect(readOpenAskOwners(join(asksDir, "missing"))).toEqual({});
  });
});

describe("workspaceWorkState", () => {
  const now = Date.parse("2026-11-12T12:00:00Z");
  const card = (fields: Partial<Status>): Status => ({
    agentId: AGENT,
    workspaceId: WS,
    state: "working",
    tldr: "t",
    done: [],
    next: [],
    updatedAt: "2026-11-12T10:00:00Z",
    turnsSince: 0,
    ...fields,
  });

  const live = { running: false, live: true };
  const idle = { running: false, live: false };

  describe("a working card", () => {
    it("keeps a workspace working while live work backs the card, however old the card", () => {
      expect(workspaceWorkState([card({ turnsSince: 5, updatedAt: "2026-11-01T00:00:00Z" })], now, () => live)).toBe("working");
      expect(workspaceWorkState([card({})], now, () => ({ running: true, live: true }))).toBe("working");
    });

    it("holds an unbacked working card for the grace period after its update", () => {
      expect(workspaceWorkState([card({ updatedAt: "2026-11-12T11:56:00Z" })], now, () => idle)).toBe("working");
      expect(workspaceWorkState([card({ updatedAt: "2026-11-12T11:55:00Z" })], now, () => idle)).toBeNull();
    });

    it("holds it for the grace period after live work was last seen, then falls back to Paseo", () => {
      const lastLiveAt = (minutesAgo: number) => () => ({ running: false, live: false, lastLiveAt: now - minutesAgo * 60_000 });
      expect(workspaceWorkState([card({})], now, lastLiveAt(4))).toBe("working");
      expect(workspaceWorkState([card({})], now, lastLiveAt(6))).toBeNull();
      expect(workspaceWorkState([card({})], now, undefined)).toBeNull();
    });

    it("lapses as soon as the grace period passes with nothing live, however recent its turns", () => {
      expect(workspaceWorkState([card({ turnsSince: 5 })], now, () => idle)).toBeNull();
    });

    it("counts another agent's backed working card over a done one", () => {
      expect(workspaceWorkState([card({ state: "done" }), card({ agentId: "b", state: "working" })], now, () => idle)).toBeNull();
      expect(workspaceWorkState([card({ state: "done" }), card({ agentId: "b", state: "working" })], now, (id) => (id === "b" ? live : idle))).toBe("working");
    });
  });

  it("reports done while every card says done, even after quiet turns made it stale", () => {
    expect(workspaceWorkState([card({ state: "done" })], now)).toBe("done");
    expect(workspaceWorkState([card({ state: "done", turnsSince: 3 })], now)).toBe("done");
    expect(workspaceWorkState([card({ state: "done" }), card({ agentId: "b", state: "working", updatedAt: "2026-11-11T11:00:00Z" })], now)).toBeNull();
  });

  it("reports waiting while a card waits on the human, over another agent's working card", () => {
    expect(workspaceWorkState([card({}), card({ agentId: "b", state: "waiting_on_you" })], now)).toBe("waiting");
    expect(workspaceWorkState([card({ state: "blocked" }), card({ agentId: "b", state: "waiting_on_you" })], now)).toBe("waiting");
  });

  it("reports blocked, not waiting, while a main workspace's card waits on its child workspaces", () => {
    expect(workspaceWorkState([card({ state: "blocked" })], now)).toBe("blocked");
    expect(workspaceWorkState([card({ state: "blocked" }), card({ agentId: "b", updatedAt: "2026-11-01T00:00:00Z" })], now, () => idle)).toBe("blocked");
    expect(workspaceWorkState([card({ state: "blocked" }), card({ agentId: "b", state: "done" })], now)).toBe("blocked");
  });

  it("lets another agent's live work outrank a blocked card", () => {
    expect(workspaceWorkState([card({ state: "blocked" }), card({ agentId: "b" })], now, (id) => (id === "b" ? live : idle))).toBe("working");
  });

  it("keeps a blocked card blocked across later turns until the agent publishes again", () => {
    // A reminder or ask-check turn ran after the card; it waits on someone else, so that is no answer.
    expect(workspaceWorkState([card({ state: "blocked", turnsSince: 2 })], now)).toBe("blocked");
    expect(workspaceWorkState([card({ state: "blocked" })], now, () => ({ running: true, live: false }))).toBe("blocked");
  });

  it("leaves answered questions, archived cards and empty workspaces to Paseo", () => {
    expect(workspaceWorkState([card({ state: "waiting_on_you", turnsSince: 1 })], now)).toBeNull();
    expect(workspaceWorkState([card({ archived: true })], now)).toBeNull();
    expect(workspaceWorkState([], now)).toBeNull();
  });
});

describe("needsYouSince", () => {
  const SNOOZED_AT = "2026-11-17T10:00:00Z";
  const card = (fields: Partial<Status>): Status => ({
    agentId: AGENT,
    workspaceId: WS,
    state: "done",
    tldr: "Both PRs merged",
    done: [],
    next: [],
    updatedAt: "2026-11-17T11:00:00Z",
    turnsSince: 0,
    ...fields,
  });

  it("names the agent whose card turned waiting or done after the snooze", () => {
    expect(needsYouSince([card({})], "done", SNOOZED_AT)).toBe(AGENT);
    const waiting = card({ agentId: "parent", state: "waiting_on_you" });
    expect(needsYouSince([card({ agentId: "child", state: "working" }), waiting], "waiting", SNOOZED_AT)).toBe("parent");
  });

  it("leaves a workspace that already needed you when it was snoozed", () => {
    expect(needsYouSince([card({ updatedAt: "2026-11-17T09:00:00Z" })], "done", SNOOZED_AT)).toBeNull();
  });

  it("never wakes a workspace for a blocked card", () => {
    expect(needsYouSince([card({ state: "blocked" })], "blocked", SNOOZED_AT)).toBeNull();
    const blocked = card({ agentId: "a", state: "blocked", updatedAt: "2026-11-17T11:30:00Z" });
    const waiting = card({ agentId: "b", state: "waiting_on_you" });
    expect(needsYouSince([blocked, waiting], "waiting", SNOOZED_AT)).toBe("b");
  });

  it("leaves a workspace whose work is still going", () => {
    expect(needsYouSince([card({ state: "working" })], "working", SNOOZED_AT)).toBeNull();
    expect(needsYouSince([card({})], null, SNOOZED_AT)).toBeNull();
  });

  it("picks the newest matching card", () => {
    const older = card({ agentId: "a", updatedAt: "2026-11-17T10:30:00Z" });
    const newer = card({ agentId: "b", updatedAt: "2026-11-17T10:45:00Z" });
    expect(needsYouSince([older, newer, card({ agentId: "c", archived: true })], "done", SNOOZED_AT)).toBe("b");
  });
});
