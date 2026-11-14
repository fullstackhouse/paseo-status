import { describe, expect, it } from "vitest";
import { Liveness, type LiveAgent } from "../server/liveness";
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
const agent = (id: string, fields: Partial<LiveAgent> = {}): LiveAgent => ({ id, running: false, parentAgentId: null, ...fields });

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

  it("wakes an idle parent once when its last live descendant stops", async () => {
    const { look } = setup();
    const children = (a: boolean, b: boolean) => [
      agent("parent"),
      agent("a", { parentAgentId: "parent", running: a }),
      agent("b", { parentAgentId: "parent", running: b }),
    ];
    expect((await look(children(true, true))).wake).toEqual([]);
    expect((await look(children(false, true))).wake).toEqual([]);
    expect((await look(children(false, false))).wake).toEqual(["parent"]);
    expect((await look(children(false, false))).wake).toEqual([]);
  });

  it("does not wake a parent that was running when its children stopped, or that has its own work left", async () => {
    const { busy, liveness, look } = setup();
    const family = (parent: boolean, child: boolean) => [agent("parent", { running: parent }), agent("child", { parentAgentId: "parent", running: child })];
    await look(family(true, true));
    expect((await look(family(false, false))).wake).toEqual([]);

    await look(family(false, true));
    busy.add("parent");
    expect((await look(family(false, false))).wake).toEqual([]);
    busy.delete("parent");
    expect((await look(family(false, false))).wake).toEqual(["parent"]);

    await look(family(false, true));
    liveness.turnEnded("parent");
    expect((await look(family(false, false))).wake).toEqual([]);
  });

  it("wakes only agents whose card says working", async () => {
    const { look } = setup();
    const family = (child: boolean) => [agent("parent"), agent("child", { parentAgentId: "parent", running: child })];
    await look(family(true));
    expect((await look(family(false), [card("parent", "done")])).wake).toEqual([]);
    await look(family(true), [card("parent", "done")]);
    expect((await look(family(false))).wake).toEqual([]);
  });

  it("counts failing background-work lookups as none", async () => {
    const liveness = new Liveness(async () => {
      throw new Error("Update the host to see an agent's background work.");
    });
    const { backing } = await liveness.assess(async () => ({ agents: [agent("parent")], statuses: [card("parent")] }));
    expect(backing.get("parent")?.live).toBe(false);
  });
});
