import { describe, expect, it } from "vitest";
import { Liveness, WAKE_DELAY_MS, type LiveAgent } from "../server/liveness";
import type { Status } from "../shared/status";

const card = (agentId: string, state: Status["state"] = "working"): Status => ({
  agentId,
  workspaceId: "wks_1",
  state,
  tldr: "t",
  done: [],
  next: [],
  updatedAt: "2026-11-12T10:00:00Z",
  turnsSince: 0,
});
const agent = (id: string, fields: Partial<LiveAgent> = {}): LiveAgent => ({ id, running: false, parentAgentId: null, workspaceBusy: false, ...fields });

function setup(now = 1_000) {
  const busy = new Set<string>();
  const clock = { now };
  const liveness = new Liveness(async (agentId) => busy.has(agentId), () => clock.now);
  const look = (agents: LiveAgent[], statuses: Status[] = [card("parent")]) => liveness.assess(async () => ({ agents, statuses }));
  return { busy, clock, liveness, look };
}

describe("Liveness", () => {
  it("backs a working card by the agent running or its own background work", async () => {
    const { busy, look } = setup();
    expect((await look([agent("parent", { running: true })])).backing.get("parent")).toMatchObject({ running: true, live: true });
    expect((await look([agent("parent")])).backing.get("parent")).toMatchObject({ live: false });
    busy.add("parent");
    expect((await look([agent("parent")])).backing.get("parent")).toMatchObject({ running: false, live: true });
  });

  it("backs it by any descendant, recursively and in any workspace, running or with background work", async () => {
    const { busy, look } = setup();
    const tree = (grandchild: Partial<LiveAgent>) => [
      agent("parent"),
      agent("child", { parentAgentId: "parent" }),
      agent("grandchild", { parentAgentId: "child", ...grandchild }),
      agent("stranger", { running: true }),
    ];
    expect((await look(tree({ running: true }))).backing.get("parent")?.live).toBe(true);
    expect((await look(tree({}))).backing.get("parent")?.live).toBe(false);
    busy.add("grandchild");
    expect((await look(tree({}))).backing.get("parent")?.live).toBe(true);
  });

  it("does not loop on a parent cycle", async () => {
    const { look } = setup();
    const agents = [agent("parent", { parentAgentId: "child" }), agent("child", { parentAgentId: "parent" })];
    expect((await look(agents)).backing.get("parent")?.live).toBe(false);
  });

  it("remembers when live work was last seen, for the grace period", async () => {
    const { clock, look } = setup(1_000);
    await look([agent("parent"), agent("child", { parentAgentId: "parent", running: true })]);
    clock.now = 9_000;
    expect((await look([agent("parent"), agent("child", { parentAgentId: "parent" })])).backing.get("parent")).toMatchObject({ live: false, lastLiveAt: 1_000 });
  });

  it("wakes an idle parent once, a minute after its last live descendant stops", async () => {
    const { clock, liveness, look } = setup();
    const children = (a: boolean, b: boolean) => [
      agent("parent"),
      agent("a", { parentAgentId: "parent", running: a }),
      agent("b", { parentAgentId: "parent", running: b }),
    ];
    expect((await look(children(true, true))).wake).toEqual([]);
    expect((await look(children(false, true))).wake).toEqual([]);
    expect(liveness.nextWakeAt()).toBeUndefined();
    expect((await look(children(false, false))).wake).toEqual([]);
    expect(liveness.nextWakeAt()).toBe(clock.now + WAKE_DELAY_MS);
    clock.now += WAKE_DELAY_MS - 1;
    expect((await look(children(false, false))).wake).toEqual([]);
    clock.now += 1;
    expect((await look(children(false, false))).wake).toEqual(["parent"]);
    clock.now += WAKE_DELAY_MS;
    expect((await look(children(false, false))).wake).toEqual([]);
    expect(liveness.nextWakeAt()).toBeUndefined();
  });

  it("drops the wake when something else woke the parent: Paseo's finish notice, its own run, or a card update", async () => {
    const family = (parent: Partial<LiveAgent>, child: boolean) => [agent("parent", parent), agent("child", { parentAgentId: "parent", running: child })];
    const armed = async () => {
      const ctx = setup();
      await ctx.look(family({}, true));
      await ctx.look(family({}, false));
      expect(ctx.liveness.nextWakeAt()).toBeDefined();
      ctx.clock.now += WAKE_DELAY_MS;
      return ctx;
    };

    const notified = await armed();
    notified.liveness.turnEnded("parent");
    expect((await notified.look(family({}, false))).wake).toEqual([]);

    const ran = await armed();
    expect((await ran.look(family({ running: true }, false))).wake).toEqual([]);
    expect((await ran.look(family({}, false))).wake).toEqual([]);

    const updated = await armed();
    expect((await updated.look(family({}, false), [{ ...card("parent"), updatedAt: "2026-11-12T10:05:00Z" }])).wake).toEqual([]);

    const childBack = await armed();
    expect((await childBack.look(family({}, true))).wake).toEqual([]);
  });

  it("counts a busy workspace as live: provider subagents only show there", async () => {
    const { clock, look } = setup();
    const family = (childBusy: boolean) => [agent("parent"), agent("child", { parentAgentId: "parent", workspaceBusy: childBusy })];
    expect((await look([agent("parent", { workspaceBusy: true })])).backing.get("parent")?.live).toBe(true);
    await look(family(true));
    expect((await look(family(true))).backing.get("parent")?.live).toBe(true);
    clock.now += WAKE_DELAY_MS;
    expect((await look(family(true))).wake).toEqual([]);
  });

  it("does not wake a parent that was running when its children stopped, or that has its own work left", async () => {
    const { busy, clock, liveness, look } = setup();
    const family = (parent: boolean, child: boolean) => [agent("parent", { running: parent }), agent("child", { parentAgentId: "parent", running: child })];
    await look(family(true, true));
    await look(family(false, false));
    expect(liveness.nextWakeAt()).toBeUndefined();

    await look(family(false, true));
    busy.add("parent");
    await look(family(false, false));
    expect(liveness.nextWakeAt()).toBeUndefined();
    busy.delete("parent");
    await look(family(false, false));
    clock.now += WAKE_DELAY_MS;
    expect((await look(family(false, false))).wake).toEqual(["parent"]);

    await look(family(false, true));
    liveness.turnEnded("parent");
    await look(family(false, false));
    expect(liveness.nextWakeAt()).toBeUndefined();
  });

  it("wakes only agents whose card says working", async () => {
    const { clock, look } = setup();
    const family = (child: boolean) => [agent("parent"), agent("child", { parentAgentId: "parent", running: child })];
    await look(family(true));
    await look(family(false), [card("parent", "done")]);
    clock.now += WAKE_DELAY_MS;
    expect((await look(family(false))).wake).toEqual([]);
  });

  it("sends a due wake-up once, however many callers share the assessment", async () => {
    const clock = { now: 1_000 };
    const woken: string[] = [];
    const liveness = new Liveness(async () => false, () => clock.now, (agentId) => woken.push(agentId));
    const family = (child: boolean) => [agent("parent"), agent("child", { parentAgentId: "parent", running: child })];
    const look = (child: boolean) => liveness.assess(async () => ({ agents: family(child), statuses: [card("parent")] }));
    await look(true);
    await look(false);
    clock.now += WAKE_DELAY_MS;
    const [a, b, c] = [look(false), look(false), look(false)];
    expect((await a).wake).toEqual(["parent"]);
    await Promise.all([b, c]);
    expect(woken).toEqual(["parent"]);
  });

  it("runs one assessment at a time, sharing a queued one", async () => {
    const liveness = new Liveness(async () => false);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const loads: string[] = [];
    const first = liveness.assess(async () => {
      loads.push("first");
      await gate;
      return { agents: [agent("parent", { running: true })], statuses: [card("parent")] };
    });
    await new Promise((resolve) => setTimeout(resolve, 0)); // the first has started loading
    const second = liveness.assess(async () => {
      loads.push("second");
      return { agents: [agent("parent")], statuses: [card("parent")] };
    });
    const third = liveness.assess(async () => {
      loads.push("third");
      return { agents: [], statuses: [] };
    });
    expect(third).toBe(second);
    release();
    await Promise.all([first, second]);
    expect(loads).toEqual(["first", "second"]);
    expect((await second).backing.get("parent")?.running).toBe(false);
  });

  it("counts failing background-work lookups as none", async () => {
    const liveness = new Liveness(async () => {
      throw new Error("Update the host to see an agent's background work.");
    });
    const { backing } = await liveness.assess(async () => ({ agents: [agent("parent")], statuses: [card("parent")] }));
    expect(backing.get("parent")?.live).toBe(false);
  });
});
