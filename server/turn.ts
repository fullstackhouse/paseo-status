import type { PaseoAgentTimelineHandle } from "@getpaseo/client";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";

type TimelineSource = Pick<PaseoAgentTimelineHandle, "refetch">;

const PAGE_SIZE = 50;

/**
 * The latest turn: its last user message and everything after it. Turn hooks carry no history (their
 * `timeline` is always empty), so read it here. Copied from paseo-asks; switch both to `latestTurn` from
 * `@getpaseo/plugin/server` once the SDK ships it (getpaseo/paseo#9307).
 */
export async function latestTurn(timeline: TimelineSource): Promise<AgentTimelineItem[]> {
  const items: AgentTimelineItem[] = [];
  let page = await timeline.refetch({ direction: "tail", limit: PAGE_SIZE });
  for (;;) {
    items.unshift(...page.entries.map((entry) => entry.item));
    const boundary = items.findLastIndex((item) => item.type === "user_message");
    if (boundary >= 0) return items.slice(boundary);
    if (!page.hasOlder || !page.startCursor) return items;
    page = await timeline.refetch({ direction: "before", cursor: page.startCursor, limit: PAGE_SIZE });
  }
}
