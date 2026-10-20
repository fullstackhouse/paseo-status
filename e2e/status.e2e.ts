import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Sandbox, waitFor } from "./harness";

const REFRESHED = /\[User\] \[status\] The human asked where things stand\. Call status_set/;
const FALLBACK = /\[User\] \[status\] The human asked where things stand, for a status card/;

describe("status in a real Paseo daemon", () => {
  let sandbox: Sandbox;
  /** Created before the plugin was installed, so it has no status_set tool. */
  let veteran: string;
  let publisher: string;

  beforeAll(async () => {
    sandbox = await Sandbox.start("status", { install: false });
    veteran = await sandbox.run('Reply with exactly "Ready." and nothing else.');
    await sandbox.install();
  });

  afterAll(async () => {
    await sandbox?.stop();
    expect(sandbox?.misses ?? [], "requests missing from the cassette; run npm run e2e:record").toEqual([]);
  });

  it("stores the status an agent publishes", async () => {
    publisher = await sandbox.run(
      'Write a file notes.txt containing "hello". Then call the status_set tool with state "done", tldr "Created notes.txt.", done ["notes.txt written"], and next []. Then reply with exactly "Done." and nothing else.',
    );
    await sandbox.settle(publisher);

    expect(await sandbox.timeline(publisher)).toContain("[mcp__status__status_set]");
    expect(sandbox.card(publisher)).toMatchObject({ state: "done", tldr: "Created notes.txt.", turnsSince: 0 });
  });

  it("Refresh asks an idle agent, which publishes again", async () => {
    const before = sandbox.card(publisher)!.updatedAt;
    expect(await sandbox.refresh(publisher)).toEqual({ sent: true });

    await sandbox.waitForTimeline(publisher, REFRESHED);
    await waitFor("a newer card", () => sandbox.card(publisher)!.updatedAt > before, 30_000);
    expect(sandbox.card(publisher)).toMatchObject({ turnsSince: 0 });
  });

  it("Refresh of a running agent waits for its turn to end instead of interrupting it", async () => {
    const agent = await sandbox.run('Run the shell command "sleep 8". Then reply with exactly "Slept." and nothing else.', { wait: false });
    await waitFor("the sleep to start", async () => /sleep 8/.test(await sandbox.timeline(agent)), 60_000);
    expect(await sandbox.refresh(agent)).toEqual({ sent: false });

    const timeline = await sandbox.waitForTimeline(agent, REFRESHED);
    // The turn finished on its own; the request came after it.
    expect(timeline.indexOf("Slept.")).toBeGreaterThan(-1);
    expect(timeline.indexOf("Slept.")).toBeLessThan(timeline.search(REFRESHED));
    await waitFor("a card", () => Boolean(sandbox.card(agent)), 30_000);
  });

  it("an agent created before install answers Refresh with a paseo-status block", async () => {
    expect(sandbox.card(veteran)).toBeUndefined();
    expect(await sandbox.refresh(veteran)).toEqual({ sent: true });

    const timeline = await sandbox.waitForTimeline(veteran, FALLBACK);
    expect(timeline).not.toContain("[mcp__status__status_set]");
    await waitFor("a card from the reply block", () => Boolean(sandbox.card(veteran)), 30_000);
    expect(sandbox.card(veteran)).toMatchObject({ turnsSince: 0 });
  });

  it("logs no plugin errors", async () => {
    expect(await sandbox.pluginLogs()).not.toMatch(/error|exception/i);
  });
});
