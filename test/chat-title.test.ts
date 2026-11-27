import type { PaseoApi } from "@getpaseo/client";
import { describe, expect, it } from "vitest";
import { chatNamer, hostNamesChats, setAutomaticTitle } from "../server/chat-title";

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

describe("hostNamesChats", () => {
  it("is true on a host whose handles have setAutomaticTitle", () => {
    expect(hostNamesChats(hostWith({ async setAutomaticTitle() {} }).api)).toBe(true);
  });

  it("is false on an older host", () => {
    expect(hostNamesChats(hostWith({}).api)).toBe(false);
  });
});

describe("chatNamer", () => {
  it("rejects, rather than throws, when there is no daemon session yet", async () => {
    const nameChat = chatNamer(() => {
      throw new Error("No daemon session yet");
    });
    let result: Promise<boolean> | undefined;
    expect(() => {
      result = nameChat("agent-1", "Gift-card checkout");
    }).not.toThrow();
    await expect(result).rejects.toThrow("No daemon session yet");
  });

  it("names the chat through the session it is given", async () => {
    const { api } = hostWith({ setAutomaticTitle: async () => ({ applied: true }) });
    expect(await chatNamer(() => api)("agent-1", "Gift-card checkout")).toBe(true);
  });
});
