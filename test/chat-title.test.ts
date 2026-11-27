import type { PaseoApi } from "@getpaseo/client";
import { describe, expect, it } from "vitest";
import { chatTitle, HOST_TITLE_MAX, setAutomaticTitle } from "../server/chat-title";

function hostWith(handle: object) {
  const refs: string[] = [];
  const api = {
    agents: {
      ref(agentId: string) {
        refs.push(agentId);
        return handle;
      },
    },
  } as unknown as PaseoApi;
  return { api, refs };
}

describe("setAutomaticTitle", () => {
  it("sends the title to the agent's handle and returns whether it landed", async () => {
    const calls: string[] = [];
    const { api, refs } = hostWith({
      async setAutomaticTitle(title: string) {
        calls.push(title);
        return { applied: false };
      },
    });
    expect(await setAutomaticTitle(api, "agent-1", "Gift-card checkout")).toBe(false);
    expect(refs).toEqual(["agent-1"]);
    expect(calls).toEqual(["Gift-card checkout"]);
  });

  it("does nothing on a host whose handles lack the method", async () => {
    const { api } = hostWith({});
    expect(await setAutomaticTitle(api, "agent-1", "Gift-card checkout")).toBe(false);
  });
});

describe("chatTitle", () => {
  const pr = (ref: string) => ({ kind: "pr" as const, ref });

  it("counts the same PR named twice as one", () => {
    expect(chatTitle("Review", [pr("a/b#7"), pr("https://github.com/a/b/pull/7")])).toBe("Review · PR 7");
  });

  it("ignores refs that aren't PRs", () => {
    expect(chatTitle("Review", [pr("the login PR")])).toBe("Review");
  });

  it("drops the PR when the title would pass the host's limit", () => {
    const long = "x".repeat(HOST_TITLE_MAX - 5);
    expect(chatTitle(long, [pr("a/b#7")])).toBe(long);
    expect(chatTitle("x".repeat(HOST_TITLE_MAX - 7), [pr("a/b#7")])).toBe(`${"x".repeat(HOST_TITLE_MAX - 7)} · PR 7`);
  });
});
