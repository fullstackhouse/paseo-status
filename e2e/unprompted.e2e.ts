import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Sandbox, type Provider } from "./harness";

/**
 * An ordinary task that never mentions status. The agent has to publish a card on its own, from the
 * status server's instructions alone; status.e2e.ts tells its agents to call status_set, so it tests
 * the wiring, not this. One sandbox per provider, so each starts from an empty repo.
 *
 * Codex defers MCP tools behind its tool search, so it reads status_set and its rules only because
 * the host tells it to look them up (fullstackhouse/paseo#93). Hosts before that publish nothing.
 */
const TASK = 'Create a file hello.txt containing "hello" and commit it with the message "Add hello.txt".';

describe.each<Provider>(["claude", "codex"])("a %s agent publishes a status card unprompted", (provider) => {
  let sandbox: Sandbox;

  beforeAll(async () => {
    sandbox = await Sandbox.start(`unprompted-${provider}`);
  });

  afterAll(async () => {
    await sandbox?.stop();
    expect(sandbox?.misses ?? [], "requests missing from the cassette; run npm run e2e:record").toEqual([]);
  });

  it("after an ordinary task", async () => {
    const agent = await sandbox.run(TASK, { provider });
    await sandbox.settle(agent);

    expect(await sandbox.timeline(agent)).toMatch(/status_set/);
    expect(sandbox.card(agent)).toMatchObject({ agentId: agent, turnsSince: 0 });
  });
});
