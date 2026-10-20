import type {
  PluginButtonContentProps,
  PluginButtonRegistration,
  PluginClientContext,
  PluginScreenProps,
  PluginSidebarItemProps,
  PluginWorkspacePanelProps,
} from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Text } from "react-native";
import { age, AgentStatus, POLL_MS, STATE_LABELS, StatusView, useStatuses } from "./client/StatusView";
import { listStatuses, refreshStatus, STALE_TURNS, type Status } from "./shared/status";

const STATE_ICONS: Record<Status["state"], string> = {
  working: "LoaderCircle",
  waiting_on_you: "Hand",
  blocked: "OctagonAlert",
  done: "CircleCheck",
};

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

function SidebarItem({ theme, currentScreen, openScreen }: PluginSidebarItemProps) {
  const query = useStatuses();
  const needsYou = query.data?.statuses.filter((status) => status.state === "waiting_on_you" || status.state === "blocked").length ?? 0;
  return (
    <SidebarRow
      icon="Gauge"
      active={currentScreen?.screenId === "status"}
      onPress={() => openScreen({ screenId: "status" })}
      trailing={
        needsYou > 0 ? <Text style={{ color: theme.colors.statusWarning, fontSize: 12 }}>{`${needsYou} need you`}</Text> : undefined
      }
    />
  );
}

function PillPopover({ theme, layout, workspaceId, ...context }: PluginButtonContentProps) {
  if (context.context !== "agent") return null;
  return <AgentStatus theme={theme} compact={layout.compact} workspaceId={workspaceId} agentId={context.agentId} />;
}

/** The pill's face: the card's state and age, or a nudge when there is no card. */
function pillFace(status: Status | undefined): { label: string; icon: string } {
  if (!status) return { label: "No status", icon: "Gauge" };
  const stale = status.turnsSince >= STALE_TURNS ? " · stale" : "";
  return { label: `${STATE_LABELS[status.state]} · ${age(status.updatedAt)}${stale}`, icon: STATE_ICONS[status.state] };
}

/** A composer pill per agent showing its status; pressing it shows the card in a popover. */
function contributePills(client: PluginClientContext): () => void {
  const pills = new Map<string, PluginButtonRegistration>();
  const lifetime = new AbortController();

  const register = (agent: { id: string; workspaceId?: string | null }) => {
    if (lifetime.signal.aborted || !agent.workspaceId || pills.has(agent.id)) return;
    pills.set(
      agent.id,
      client.addComposerPill({
        id: "status",
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        button: { title: "Status", ...pillFace(undefined), behavior: { kind: "popover", Content: PillPopover } },
      }),
    );
  };
  const drop = (agentId: string) => {
    pills.get(agentId)?.remove();
    pills.delete(agentId);
  };

  const refreshFaces = async () => {
    const { statuses } = await client.rpc(listStatuses, {});
    const byAgent = new Map(statuses.map((status) => [status.agentId, status]));
    for (const [agentId, pill] of pills) pill.update(pillFace(byAgent.get(agentId)));
  };
  const timer = setInterval(() => void refreshFaces().catch(() => undefined), POLL_MS * 2);

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          for (const agentId of [...pills.keys()]) drop(agentId);
          for (const { agent } of entries) register(agent);
          void refreshFaces().catch(() => undefined);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "upsert") return register(update.agent);
          drop(update.agentId);
        },
      });
      return undefined;
    })
    .catch((error) => {
      if (!lifetime.signal.aborted) console.error("[status] agent observation failed", error);
    });

  return () => {
    lifetime.abort();
    clearInterval(timer);
    for (const agentId of [...pills.keys()]) drop(agentId);
  };
}

export default function contribute(client: PluginClientContext) {
  client.addWorkspacePanel({
    id: "status",
    title: "Status",
    icon: "Gauge",
    context: "workspace",
    locations: ["workspace", "explorer"],
    Component: WorkspacePanel,
  });
  client.addScreen({ id: "status", title: "Status", Component: GlobalScreen });
  client.addSidebarHeaderItem({ id: "status", title: "Status", Component: SidebarItem });
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
  return contributePills(client);
}
