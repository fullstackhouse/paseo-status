import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { chatItemsFor, STATUS_CARD, StatusCardSchema, type StatusCard } from "../shared/timeline";
import { InlineStatus } from "./StatusView";

/** Status cards in the agent chat, folded to one line until pressed. */
export function contributeChatCards(client: PluginClientContext): () => void {
  function TimelineCard({ theme, layout, agentId, item }: PluginTimelineItemProps<StatusCard>) {
    return <InlineStatus theme={theme} compact={layout.compact} agentId={agentId} {...item.data} />;
  }

  const removeTransformer = client.addTimelineTransformer({
    id: "status-cards",
    query: { itemType: "tool_call" },
    transform: ({ item }) => chatItemsFor(item),
  });
  const removeRenderer = client.addTimelineRenderer({ ...STATUS_CARD, schema: StatusCardSchema, Component: TimelineCard });

  return () => {
    removeTransformer();
    removeRenderer();
  };
}
