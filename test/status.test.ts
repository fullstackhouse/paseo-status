import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { BACKGROUND_SKIP, FALLBACK_PROMPT, HELPER_SKIP, INSTRUCTIONS, REFRESH_PROMPT, StatusService, SYNC_ASKS_PROMPT, TOOLS, WAKE_PROMPT, type AgentState, type Courier } from "../server/service";
import { StatusStore } from "../server/store";
import { agentCard, answersCard, answersTurn, runsReply, DONE_WITH_NEXT, isAnswered, needsYou, stateTone, needsYouSince, overviewStatus, workspaceOverviewStatus, type Status } from "../shared/status";

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
    await service.callTool(AGENT, "status_set", { ...status, state: "done", tldr: "Shipped.", next: [] });
    const reloaded = new StatusStore(dir).list(WS);
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]).toMatchObject({ agentId: AGENT, state: "done", tldr: "Shipped.", turnsSince: 0 });
  });

  it("rejects done while next still lists steps, so Archive isn't offered for untested work", async () => {
    // The human still has to test it: the card must say waiting_on_you, not done.
    const result = await service.callTool(AGENT, "status_set", { ...status, state: "done", next: ["You: test it before the PR"] });
    expect(result).toEqual({ text: DONE_WITH_NEXT, isError: true });
    expect(store.list(WS)).toHaveLength(0);
    expect((await service.callTool(AGENT, "status_set", { ...status, state: "waiting_on_you", next: ["You: test it before the PR"] })).isError).toBeFalsy();
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

  it("asks an idle agent to sync its asks with its card", async () => {
    await service.callTool(AGENT, "status_set", { ...status, state: "waiting_on_you" });
    await service.turnEnded(AGENT);
    expect(await service.syncAsks(AGENT)).toEqual({ sent: true });
    expect(courier.sent).toEqual([{ agentId: AGENT, text: SYNC_ASKS_PROMPT }]);
    expect(store.get(AGENT)?.refreshRequestedAt).toBeDefined();
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

  it("publishes a done block with steps left as waiting on the human", async () => {
    const block = JSON.stringify({ state: "done", tldr: "Fix committed.", done: [], next: ["You: test it"] });
    await service.turnEnded(AGENT, [{ type: "assistant_message", text: `\`\`\`paseo-status\n${block}\n\`\`\`` }] as any);
    expect(store.get(AGENT)).toMatchObject({ state: "waiting_on_you", next: ["You: test it"] });
  });

  it("ignores an unreadable paseo-status block", async () => {
    await service.turnEnded(AGENT, [{ type: "assistant_message", text: "```paseo-status\n{nope\n```" }] as any);
    expect(store.get(AGENT)).toBeUndefined();
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

describe("agentCard", () => {
  const card = (fields: Partial<Status>): Status => ({
    agentId: AGENT, workspaceId: WS, state: "waiting_on_you", tldr: "t", done: [], next: [], updatedAt: "2026-11-26T10:00:00Z", turnsSince: 0, ...fields,
  });
  const idle = { running: false, live: false };

  it("reports the card's facts, not a verdict: the state as written, when, and what backs it", () => {
    expect(agentCard(card({}), idle)).toEqual({ agentId: AGENT, state: "waiting_on_you", updatedAt: Date.parse("2026-11-26T10:00:00Z") });
    expect(agentCard(card({ state: "working" }), { running: false, live: true, lastLiveAt: 5 })).toMatchObject({ state: "working", live: true, lastLiveAt: 5 });
  });

  it("marks a card a turn started after as answered", () => {
    expect(agentCard(card({ turnsSince: 1 }), idle)).toMatchObject({ answered: true });
    expect(agentCard(card({ state: "blocked", turnsSince: 1 }), idle)).not.toHaveProperty("answered");
  });

  it("passes live children through as they are: Paseo decides that the card reads blocked", () => {
    expect(agentCard(card({}), { ...idle, liveChildren: ["child-1"] })).toMatchObject({ state: "waiting_on_you", liveChildren: ["child-1"] });
    expect(agentCard(card({}), { ...idle, liveChildren: [] })).not.toHaveProperty("liveChildren");
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

  const idle = () => false;

  it("names the agent whose card turned waiting after the snooze, or done once every card is", () => {
    expect(needsYouSince([card({})], SNOOZED_AT, idle)).toBe(AGENT);
    const waiting = card({ agentId: "parent", state: "waiting_on_you" });
    expect(needsYouSince([card({ agentId: "child", state: "working" }), waiting], SNOOZED_AT, idle)).toBe("parent");
  });

  it("leaves a workspace that already needed you when it was snoozed", () => {
    expect(needsYouSince([card({ updatedAt: "2026-11-17T09:00:00Z" })], SNOOZED_AT, idle)).toBeNull();
  });

  it("never wakes a workspace for a blocked card", () => {
    expect(needsYouSince([card({ state: "blocked" })], SNOOZED_AT, idle)).toBeNull();
    const blocked = card({ agentId: "a", state: "blocked", updatedAt: "2026-11-17T11:30:00Z" });
    const waiting = card({ agentId: "b", state: "waiting_on_you" });
    expect(needsYouSince([blocked, waiting], SNOOZED_AT, idle)).toBe("b");
  });

  it("leaves a workspace whose work is still going, or whose question was answered", () => {
    expect(needsYouSince([card({ state: "working" })], SNOOZED_AT, idle)).toBeNull();
    expect(needsYouSince([card({}), card({ agentId: "b", state: "working" })], SNOOZED_AT, idle)).toBeNull();
    expect(needsYouSince([card({ state: "waiting_on_you", turnsSince: 1 })], SNOOZED_AT, idle)).toBeNull();
  });

  it("picks the newest matching card", () => {
    const older = card({ agentId: "a", updatedAt: "2026-11-17T10:30:00Z" });
    const newer = card({ agentId: "b", updatedAt: "2026-11-17T10:45:00Z" });
    expect(needsYouSince([older, newer, card({ agentId: "c", archived: true })], SNOOZED_AT, idle)).toBe("b");
  });
});

describe("turns plugins start", () => {
  const userTurn = (text: string) => [{ type: "user_message", text }, { type: "assistant_message", text: "ok" }] as any;
  const ASKS_CHECK = "[asks] A check found that your last reply leaves something for the human (a question), and no ask records it.";
  const STUCK = "[asks] Your turn ended with A4 (Merge PR #40) in progress, so the human sees no buttons on it. For each: leave it.";
  const PR_UPDATE = "[asks] A8 (Request review on PR #268) PR #268 checks passing.";
  const NOTHING_MOVING = "[asks] A3 (Deploy) shows nothing moving: update it or hand it back.";
  const ASK_ANSWER = '[asks] A3 (Merge PR #98?) "Merge with --admin": Merge it. When it is done, call ask_resolve for A3.';

  it("tells a human or child prompt from a plugin's check, reminder or watcher message", () => {
    for (const text of [ASKS_CHECK, STUCK, PR_UPDATE, NOTHING_MOVING, REFRESH_PROMPT, SYNC_ASKS_PROMPT, WAKE_PROMPT, FALLBACK_PROMPT, "[asks] The human wants your asks up to date. Run ask_list."])
      expect(answersCard(text), text).toBe(false);
    for (const text of ["merge it", ASK_ANSWER, "[asks] A3 (Pick) reply from the human: \"red\". Update or resolve A3 accordingly.", `${STUCK}\n${ASK_ANSWER}`, undefined])
      expect(answersCard(text), String(text)).toBe(true);
  });

  it("reads who started the turn when the host says so", () => {
    const human = { kind: "human" } as const;
    const plugin = { kind: "plugin", pluginId: "paseo-asks" } as const;
    expect(answersTurn({ text: ASKS_CHECK, origin: human })).toBe(true);
    expect(answersTurn({ text: "merge it", origin: { kind: "agent", agentId: "child" } })).toBe(true);
    expect(answersTurn({ text: "Resume working.", origin: { kind: "system" } })).toBe(false);
    // A plugin's own prompt doesn't answer, even worded in a way no pattern knows.
    expect(answersTurn({ text: "[asks] A brand new nudge nobody wrote a pattern for.", origin: plugin })).toBe(false);
    expect(answersTurn({ text: "Please double-check your plan.", origin: { kind: "plugin", pluginId: "other" } })).toBe(false);
    for (const text of [ASKS_CHECK, STUCK, PR_UPDATE, NOTHING_MOVING]) expect(answersTurn({ text, origin: plugin }), text).toBe(false);
    // paseo-asks relaying the human's button press or reply is the human answering.
    expect(answersTurn({ text: ASK_ANSWER, origin: plugin })).toBe(true);
    expect(answersTurn({ text: `${STUCK}\n${ASK_ANSWER}`, origin: plugin })).toBe(true);
    // Older hosts send no origin: fall back to the prompt text.
    expect(answersTurn({ text: ASKS_CHECK })).toBe(false);
    expect(answersTurn({ text: "[asks] A brand new nudge nobody wrote a pattern for." })).toBe(true);
    expect(answersTurn(undefined)).toBe(true);
  });

  it("a waiting card stays unanswered through an Asks check turn, and a human reply answers it", async () => {
    const store = new StatusStore(mkdtempSync(join(tmpdir(), "status-")));
    const service = new StatusService(store, new FakeCourier(), async () => WS);
    await service.callTool(AGENT, "status_set", { ...status, state: "waiting_on_you" });
    await service.turnEnded(AGENT); // the turn that set it
    await service.turnEnded(AGENT, userTurn(ASKS_CHECK));
    await service.turnEnded(AGENT, userTurn(STUCK));
    expect(needsYou(store.get(AGENT)!, false)).toBe(true);
    expect(isAnswered(store.get(AGENT)!, false)).toBe(false);
    expect(store.get(AGENT)!.turnsSince).toBe(2); // still stale for Refresh's count
    await service.turnEnded(AGENT, userTurn("merged, thanks"));
    expect(isAnswered(store.get(AGENT)!, false)).toBe(true);
  });

  it("with the host's origin, an unknown plugin prompt leaves the card waiting and a person's answers it", async () => {
    const store = new StatusStore(mkdtempSync(join(tmpdir(), "status-")));
    const service = new StatusService(store, new FakeCourier(), async () => WS);
    await service.callTool(AGENT, "status_set", { ...status, state: "waiting_on_you" });
    await service.turnEnded(AGENT);
    await service.turnEnded(AGENT, userTurn("Any news on the deploy?"), { kind: "plugin", pluginId: "pinger" });
    await service.turnEnded(AGENT, userTurn("Resume working."), { kind: "system" });
    expect(isAnswered(store.get(AGENT)!, false)).toBe(false);
    // The origin can also come on the timeline's user message itself.
    await service.turnEnded(AGENT, [{ type: "user_message", text: "[status] anything", origin: { kind: "human" } }] as any);
    expect(isAnswered(store.get(AGENT)!, false)).toBe(true);
  });

  it("a plugin's turn still running doesn't answer the card; a person's does", async () => {
    const store = new StatusStore(mkdtempSync(join(tmpdir(), "status-")));
    const service = new StatusService(store, new FakeCourier(), async () => WS);
    await service.callTool(AGENT, "status_set", { ...status, state: "waiting_on_you" });
    await service.turnEnded(AGENT);
    const card = store.get(AGENT)!;
    expect(agentCard(card, { running: true, pluginTurn: true, live: true })).not.toHaveProperty("answered");
    expect(agentCard(card, { running: true, live: true })).toHaveProperty("answered", true);
    expect(runsReply({ running: true, pluginTurn: true })).toBe(false);
    expect(runsReply(undefined)).toBe(false);
  });
});
