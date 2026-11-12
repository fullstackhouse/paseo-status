import type { PluginClientContext } from "@getpaseo/plugin/client";
import { listStatuses, workspaceWorkState, type Status, type WorkState } from "../shared/status";
import { age, POLL_MS, STATE_LABELS } from "./StatusView";

// COMPAT(workspaceSummaryItem): FSH hosts have addWorkspaceSummaryItem (and `workState` from
// fullstackhouse/paseo's agent-reported grouping), but the npm SDK pin doesn't type them yet.
// Older hosts lack it; Status then only shows its pills and row badge.
interface SummaryState {
  label?: string;
  panelId?: string;
  workState?: WorkState | null;
}
interface SummaryRegistration {
  update(patch: SummaryState): void;
  remove(): void;
}
type SummaryHost = {
  addWorkspaceSummaryItem?: (
    contribution: SummaryState & { id: string; workspaceId: string; title: string },
  ) => SummaryRegistration;
};

/** The newest card in a workspace, for the item's label. */
function newest(statuses: readonly Status[]): Status | undefined {
  return statuses.reduce<Status | undefined>(
    (latest, status) => (!latest || status.updatedAt > latest.updatedAt ? status : latest),
    undefined,
  );
}

/**
 * One summary item per workspace with a card: its newest state for the Overview tab, and the
 * work state Paseo's agent-reported grouping reads. Never sets `needsYou`, so it doesn't open
 * Explorer; cards waiting on the human are left to Paseo's turn state and the asks plugin.
 */
export function contributeWorkspaceSummaries(client: PluginClientContext): () => void {
  const host = client as PluginClientContext & SummaryHost;
  const add = host.addWorkspaceSummaryItem;
  if (!add) return () => undefined;
  const items = new Map<string, SummaryRegistration>();
  let stopped = false;

  const refresh = async () => {
    const { statuses } = await client.rpc(listStatuses, {});
    if (stopped) return;
    const byWorkspace = new Map<string, Status[]>();
    for (const status of statuses) {
      if (status.archived) continue;
      const list = byWorkspace.get(status.workspaceId);
      if (list) list.push(status);
      else byWorkspace.set(status.workspaceId, [status]);
    }
    const now = Date.now();
    for (const [workspaceId, cards] of byWorkspace) {
      const latest = newest(cards);
      const state: SummaryState = {
        label: latest ? `${STATE_LABELS[latest.state]} · ${age(latest.updatedAt)}` : undefined,
        panelId: "status",
        workState: workspaceWorkState(cards, now),
      };
      const item = items.get(workspaceId);
      if (item) item.update(state);
      else items.set(workspaceId, add.call(host, { id: "status", workspaceId, title: "Status", ...state }));
    }
    for (const [workspaceId, item] of items) {
      if (byWorkspace.has(workspaceId)) continue;
      item.remove();
      items.delete(workspaceId);
    }
  };

  void refresh().catch(() => undefined);
  const timer = setInterval(() => void refresh().catch(() => undefined), POLL_MS * 2);
  return () => {
    stopped = true;
    clearInterval(timer);
    for (const item of items.values()) item.remove();
    items.clear();
  };
}
