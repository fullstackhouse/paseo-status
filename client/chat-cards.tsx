import { settingsRpc } from "@getpaseo/plugin";
import { useSettings, type PluginClientContext, type PluginSurfaceProps, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useEffect } from "react";
import { Text } from "react-native";
import { CHAT_CARD_OPTIONS, chatCardsOf, chatSettings, type ChatCards } from "../shared/settings";
import { chatItemsFor, STATUS_CARD, StatusCardSchema, type StatusCard } from "../shared/timeline";
import { InlineStatus, POLL_MS } from "./StatusView";

const SETTINGS_RPC = settingsRpc(chatSettings.id);

/**
 * Status cards in the agent chat, shown expanded, collapsed or not at all per the host's Chat setting.
 *
 * Collapsing is the renderer's job (it reads the setting live). Hiding has to happen in the
 * transformer, since a renderer that draws nothing still leaves its row's gap. Paseo caches a
 * transformer's output per row, so a change to or from Hidden registers the transformer again:
 * that is what makes Paseo redo rows it already showed. The transformer learns the setting from a
 * read at startup, from any mounted card or settings screen (pushed on save), and from a poll for
 * saves on other devices while no card is mounted to hear them.
 */
export function contributeChatCards(client: PluginClientContext): () => void {
  let cards: ChatCards = "expanded";
  let removeTransformer = addTransformer();
  let disposed = false;

  function addTransformer() {
    const current = cards;
    return client.addTimelineTransformer({
      id: "status-cards",
      query: { itemType: "tool_call" },
      transform: ({ item }) => chatItemsFor(item, current),
    });
  }
  function apply(next: ChatCards | undefined) {
    if (disposed || !next || next === cards) return;
    const hiddenChanged = (next === "hidden") !== (cards === "hidden");
    cards = next;
    if (!hiddenChanged) return;
    removeTransformer();
    removeTransformer = addTransformer();
  }
  const read = () =>
    client
      .rpc(SETTINGS_RPC.read, {})
      .then((result) => apply(result.status === "ready" ? chatCardsOf(result.values) : undefined))
      .catch(() => undefined);
  void read();
  const timer = setInterval(() => void read(), POLL_MS * 4);

  /** Mounted cards and the settings screen hear saves as they happen and pass them on. */
  function useReportCards(current: ChatCards | undefined) {
    useEffect(() => apply(current), [current]);
  }

  function TimelineCard({ theme, layout, agentId, item }: PluginTimelineItemProps<StatusCard>) {
    const settings = useSettings(chatSettings);
    const current = settings.status === "ready" ? settings.values.cards : undefined;
    useReportCards(current);
    // Until the setting loads, draw nothing rather than a card that may be about to collapse or go.
    if (settings.status === "loading" || current === "hidden") return null;
    return <InlineStatus theme={theme} compact={layout.compact} agentId={agentId} collapsed={current === "collapsed"} {...item.data} />;
  }

  function ChatSettingsScreen({ theme }: PluginSurfaceProps) {
    const settings = useSettings(chatSettings);
    useReportCards(settings.status === "ready" ? settings.values.cards : undefined);
    const muted = { color: theme.colors.foregroundMuted };
    if (settings.status === "loading") return <Text style={muted}>Loading settings…</Text>;
    if (settings.status !== "ready") return <Text style={{ color: theme.colors.statusDanger }}>{settings.error}</Text>;
    return (
      <SettingsSection title="Chat">
        <SettingsCard>
          <SettingsSelect
            label="Status in chat"
            hint="Where an agent publishes its status. The Status panel and the composer pill show it either way."
            value={settings.values.cards}
            options={CHAT_CARD_OPTIONS}
            disabled={settings.saving}
            error={settings.saveError}
            onValueChange={(next: ChatCards) => void settings.save({ ...settings.values, cards: next }, settings.revision)}
          />
        </SettingsCard>
      </SettingsSection>
    );
  }

  const removeRenderer = client.addTimelineRenderer({ ...STATUS_CARD, schema: StatusCardSchema, Component: TimelineCard });
  const removeScreen = client.addSettingsScreen({ id: "chat", title: "Chat", icon: "MessageSquare", Component: ChatSettingsScreen });
  const removeCommand = client.addCommandCenterItem({
    id: "chat-settings",
    title: "Status cards in chat: expand, collapse or hide",
    icon: "Settings",
    context: "global",
    keywords: ["status", "chat", "collapse", "hide", "settings"],
    onSelect: ({ openSettings }) => openSettings("chat"),
  });

  return () => {
    disposed = true;
    clearInterval(timer);
    removeTransformer();
    removeRenderer();
    removeScreen();
    removeCommand();
  };
}
