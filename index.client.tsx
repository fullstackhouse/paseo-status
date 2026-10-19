import type { PluginClientContext, PluginScreenProps, PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { StatusView } from "./client/StatusView";
import { refreshStatus } from "./shared/status";

function WorkspacePanel({ theme, layout, workspaceId, navigation }: PluginWorkspacePanelProps) {
  return (
    <StatusView
      theme={theme}
      compact={layout.compact}
      workspaceId={workspaceId}
      openAgent={navigation ? (agentId) => navigation.openAgent({ agentId }) : undefined}
    />
  );
}

function GlobalScreen({ theme, layout, navigation }: PluginScreenProps) {
  return (
    <StatusView
      theme={theme}
      compact={layout.compact}
      openAgent={navigation ? (agentId) => navigation.openAgent({ agentId }) : undefined}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({ id: "status", title: "Status", icon: "Gauge", context: "workspace", Component: WorkspacePanel });
  client.addScreen({ id: "status", title: "Status", Component: GlobalScreen });
  client.addCommandCenterItem({
    id: "open-status",
    title: "Open status for this workspace",
    icon: "Gauge",
    context: "workspace",
    keywords: ["status", "tldr", "summary", "where are we"],
    onSelect: ({ openPanel }) => openPanel("status"),
  });
  client.addCommandCenterItem({
    id: "open-all-status",
    title: "Open status across workspaces",
    icon: "Gauge",
    context: "global",
    keywords: ["status", "tldr", "summary", "where are we"],
    onSelect: ({ openScreen }) => openScreen({ screenId: "status" }),
  });
  // Replaces typing "tldr, where are we?": the agent updates its card instead of answering in chat.
  client.addSlashCommand({
    name: "paseo-status",
    description: "Ask this agent to update its status card",
    argumentHint: "",
    context: "agent",
    async onSubmit({ agent, rpc, openPanel }) {
      await rpc(refreshStatus, { agentId: agent.id });
      openPanel("status");
    },
  });
  return () => {};
}
