import { describe, expect, it } from "vitest";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { latestTurn } from "../server/turn";

const user = (text: string): AgentTimelineItem => ({ type: "user_message", text });
const reply = (text: string): AgentTimelineItem => ({ type: "assistant_message", text });

/** Serves `history` in pages of `size`, newest first, like the daemon's tail/before cursors. */
function paged(history: AgentTimelineItem[], size: number) {
  const requests: string[] = [];
  return {
    requests,
    async refetch(options?: { direction?: string; cursor?: string }) {
      const end = options?.direction === "before" ? Number(options.cursor) : history.length;
      const start = Math.max(0, end - size);
      requests.push(`${options?.direction}:${end}`);
      return { entries: history.slice(start, end).map((item) => ({ item })), hasOlder: start > 0, startCursor: start > 0 ? String(start) : null };
    },
  };
}

describe("latestTurn", () => {
  it("returns the last user message and the reply after it", async () => {
    const source = paged([user("one"), reply("first"), user("two"), reply("a"), reply("b")], 50);
    expect(await latestTurn(source as never)).toEqual([user("two"), reply("a"), reply("b")]);
  });

  it("pages back until it reaches the user message", async () => {
    const source = paged([user("go"), ...Array.from({ length: 120 }, (_, i) => reply(String(i)))], 50);
    const turn = await latestTurn(source as never);
    expect(turn[0]).toEqual(user("go"));
    expect(turn).toHaveLength(121);
    expect(source.requests).toEqual(["tail:121", "before:71", "before:21"]);
  });
});
