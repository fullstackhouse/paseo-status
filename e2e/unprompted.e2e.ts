import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HOST, Sandbox, type Provider } from "./harness";

/**
 * An ordinary task that never mentions status. The agent has to publish a card on its own, from the
 * status server's instructions alone; status.e2e.ts tells its agents to call status_set, so it tests
 * the wiring, not this. One sandbox per provider, so each starts from an empty repo.
 */
const TASK = 'Create a file hello.txt containing "hello" and commit it with the message "Add hello.txt".';

/**
 * Codex defers MCP tools behind its tool search, so the model never reads status_set or its rules
 * unless the host tells it to look them up. Hosts up to this tag do not, and their Codex agents
 * publish nothing. The cassette was recorded with PASEO_HOST_SRC on a build with that fix
 * (fullstackhouse/paseo, branch merry-porcupine).
 * TODO: bump TAG in fsh-host.mjs to a release with the fix; this skip then lifts by itself.
 */
const HOST_WITHOUT_CODEX_FIX = "fsh-cli-0.15.3-0bd77c5";

describe.each<Provider>(["claude", "codex"])("a %s agent publishes a status card unprompted", (provider) => {
  let sandbox: Sandbox;
  const skip = provider === "codex" && HOST === HOST_WITHOUT_CODEX_FIX;

  beforeAll(async () => {
    if (!skip) sandbox = await Sandbox.start(`unprompted-${provider}`);
  });

  afterAll(async () => {
    await sandbox?.stop();
    expect(sandbox?.misses ?? [], "requests missing from the cassette; run npm run e2e:record").toEqual([]);
  });

  it.skipIf(skip)("after an ordinary task", async () => {
    const agent = await sandbox.run(TASK, { provider });
    await sandbox.settle(agent);

    expect(await sandbox.timeline(agent)).toMatch(/status_set/);
    expect(sandbox.card(agent)).toMatchObject({ agentId: agent, turnsSince: 0 });
  });
});
