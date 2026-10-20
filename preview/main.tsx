import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { Text, View } from "react-native";
import { AgentStatus, InlineStatus, StatusView } from "../client/StatusView";
import { earlierGiftcards, statuses } from "./fixtures";

const theme = {
  colors: {
    surface0: "#121316",
    surface1: "#1a1c20",
    surface2: "#24272c",
    border: "#2e3238",
    foreground: "#e8e9eb",
    foregroundMuted: "#8b9099",
    accent: "#7c8cff",
    accentForeground: "#0d0f1a",
    statusSuccess: "#4cc38a",
    statusWarning: "#e5a54b",
    statusDanger: "#ef6a6a",
  },
};

function Frame(props: { id: string; title: string; width: number; height: number; children: React.ReactNode }) {
  return (
    <View testID={props.id} style={{ width: props.width, height: props.height, borderRadius: 12, overflow: "hidden", borderWidth: 1, borderColor: theme.colors.border }}>
      <View style={{ paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 }}>
        <Text style={{ color: theme.colors.foreground, fontWeight: "600" }}>{props.title}</Text>
      </View>
      <View style={{ flex: 1 }}>{props.children}</View>
    </View>
  );
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <Frame id="panel" title="Status · shop-api" width={620} height={880}>
      <StatusView theme={theme as any} compact={false} workspaceId="api" openAgent={() => {}} />
    </Frame>
    <Frame id="phone" title="Status" width={390} height={790}>
      <StatusView theme={theme as any} compact openAgent={() => {}} />
    </Frame>
    <Frame id="popover" title="Pill popover" width={440} height={560}>
      <AgentStatus theme={theme as any} compact={false} workspaceId="api" agentId="agent-giftcards" />
    </Frame>
    <Frame id="chat" title="Agent chat" width={620} height={700}>
      <View style={{ padding: 16, gap: 12, backgroundColor: theme.colors.surface0, flex: 1 }}>
        <InlineStatus theme={theme as any} compact={false} agentId="agent-giftcards" {...earlierGiftcards} />
        <InlineStatus theme={theme as any} compact={false} agentId="agent-giftcards" {...statuses[0]!} />
      </View>
    </Frame>
  </QueryClientProvider>,
);
