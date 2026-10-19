import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { readWaiting, REFRESH_PROMPT, StatusService, type AgentState, type Courier } from "../server/service";
import { StatusStore } from "../server/store";

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
const status = { state: "working", tldr: "Adding memoized steps; tests pass, soak test running.", done: ["unit tests: 105/105"], next: ["commit and push"] };

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

  it("reads open asks from the asks plugin's store, when present", () => {
    const asksDir = join(dir, "asks");
    mkdirSync(join(asksDir, "workspaces"), { recursive: true });
    writeFileSync(
      join(asksDir, "workspaces", `${WS}.json`),
      JSON.stringify({
        nextId: 3,
        asks: [
          { id: "A1", title: "Merge PR #22?", ownerAgentId: AGENT, status: "open" },
          { id: "A2", title: "Name it memo?", ownerAgentId: AGENT, status: "done" },
        ],
      }),
    );
    expect(readWaiting(asksDir, [WS, "wks_missing"])).toEqual([{ id: "A1", title: "Merge PR #22?", agentId: AGENT }]);
  });
});
