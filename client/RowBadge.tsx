import type { PluginClientContext, PluginHostProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import * as ui from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import type { ComponentType } from "react";
import { rowBadgeLabel, summarizeWorkspaces } from "../shared/status";
import { POLL_MS } from "./StatusView";

// The workspace row API arrived after @getpaseo/plugin 0.12; typed here until the SDK ships it.
// Older hosts lack `addWorkspaceRowItem`, so the badge is only registered where it exists.
type BadgeTone = "muted" | "success" | "warning" | "danger" | "info";
interface WorkspaceRowBadgeProps {
  icon?: string;
  label?: string;
  tone?: BadgeTone;
  accessibilityLabel?: string;
}
interface WorkspaceRowItemProps extends PluginHostProps {
  workspaceId: string;
}
type RowItemClient = PluginClientContext & {
  addWorkspaceRowItem?: (contribution: {
    id: string;
    title: string;
    icon: string;
    Component: ComponentType<WorkspaceRowItemProps>;
  }) => () => void;
};

/** One query for every row on the host: the plugin's query client is shared by all its components. */
function useWorkspaceSummaries() {
  const summarize = useRpc(summarizeWorkspaces);
  return useQuery({
    queryKey: ["status", "summary"],
    queryFn: () => summarize({}),
    refetchInterval: POLL_MS,
  });
}

function WorkspaceStatusBadge({ workspaceId }: WorkspaceRowItemProps) {
  const label = rowBadgeLabel(useWorkspaceSummaries().data?.workspaces[workspaceId]);
  const Badge = (ui as { WorkspaceRowBadge?: ComponentType<WorkspaceRowBadgeProps> }).WorkspaceRowBadge;
  if (!label || !Badge) return null;
  return <Badge icon="Hand" label={label} tone="warning" accessibilityLabel={`Status: ${label}`} />;
}

export function contributeRowBadge(client: PluginClientContext): () => void {
  const add = (client as RowItemClient).addWorkspaceRowItem;
  if (!add) return () => undefined;
  return add.call(client, { id: "status", title: "Status", icon: "Gauge", Component: WorkspaceStatusBadge });
}
