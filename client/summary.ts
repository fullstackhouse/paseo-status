import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import type { ComponentType } from "react";
import { listStatuses, newestCard, workspaceOverviewStatus, type OverviewStatus, type Status, type WorkState } from "../shared/status";
import { age, POLL_MS, STATE_LABELS, SyncAsksEntry, unrecordedIn } from "./StatusView";

// COMPAT(workspaceSummaryItem): FSH hosts have addWorkspaceSummaryItem (and `workState` from
// fullstackhouse/paseo's agent-reported grouping, `status` from its Overview v2), but the npm SDK pin
// doesn't type them yet. Hosts before the Blocked group drop `workState: "blocked"` and group the
// workspace by its turn.
// Older hosts lack it; Status then only shows its pills and row badge.
interface SummaryState {
  label?: string;
  panelId?: string;
  workState?: WorkState | null;
  /**
   * The newest card, shown as the Overview's Status card, with the workspace's newest goal and, while
   * blocked, what it waits on. Older hosts drop the field (and hosts before `goal`/`blockedBy`, those).
   */
  status?: OverviewStatus | null;
  /** FSH Overview v2: Your move rows, each rendered by the item's `EntryComponent`. */
  needsYou?: boolean;
  key?: string;
  entries?: { id: string; title: string; detail?: string }[];
}
/** What an Overview v2 host passes to `EntryComponent`. */
interface EntryProps {
  theme: PluginTheme;
  layout: { compact: boolean };
  entryId: string;
}
interface SummaryRegistration {
  update(patch: SummaryState): void;
  remove(): void;
}
type SummaryHost = {
  addWorkspaceSummaryItem?: (
    contribution: SummaryState & { id: string; workspaceId: string; title: string; EntryComponent?: ComponentType<EntryProps> },
  ) => SummaryRegistration;
};

/**
 * One summary item per workspace with a card: its newest state for the Overview tab, and the
 * work state Paseo's agent-reported grouping reads. Never sets `needsYou`, so it doesn't open
 * Explorer; a card waiting on the human reports `waiting` instead.
 */
export function contributeWorkspaceSummaries(client: PluginClientContext): () => void {
  const host = client as PluginClientContext & SummaryHost;
  const add = host.addWorkspaceSummaryItem;
  if (!add) return () => undefined;
  const items = new Map<string, SummaryRegistration>();
  // A second item per workspace, only while a card waits on the human with no open ask: its Your move row offers Sync asks.
  const gaps = new Map<string, SummaryRegistration>();
  let stopped = false;

  const refresh = async () => {
    // The server decides the work state: only it sees child agents and background work.
    const list = await client.rpc(listStatuses, { withWorkStates: true });
    const { statuses, agents, workStates = {}, blockers = {} } = list;
    if (stopped) return;
    const unrecorded = unrecordedIn(list);
    const byWorkspace = new Map<string, Status[]>();
    for (const status of statuses) {
      if (status.archived) continue;
      const list = byWorkspace.get(status.workspaceId);
      if (list) list.push(status);
      else byWorkspace.set(status.workspaceId, [status]);
    }
    for (const [workspaceId, cards] of byWorkspace) {
      const latest = newestCard(cards);
      const state: SummaryState = {
        label: latest ? `${STATE_LABELS[latest.state]} · ${age(latest.updatedAt)}` : undefined,
        panelId: "status",
        workState: workStates[workspaceId] ?? null,
        status: workspaceOverviewStatus(cards, (agentId) => agents[agentId]?.running ?? false, blockers),
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
    const gapCards = new Map<string, Status[]>();
    for (const [workspaceId, cards] of byWorkspace) {
      const missing = cards.filter((card) => unrecorded.has(card.agentId));
      if (missing.length > 0) gapCards.set(workspaceId, missing);
    }
    for (const [workspaceId, cards] of gapCards) {
      const state: SummaryState = {
        label: "No ask for what waits on you",
        panelId: "status",
        needsYou: true,
        // A new card is new attention; the same card staying unrecorded is not.
        key: cards.map((card) => `${card.agentId}:${card.updatedAt}`).join(","),
        entries: cards.map((card) => ({
          id: card.agentId,
          title: "Status waits on you, but no ask says what",
          detail: agents[card.agentId]?.title ?? undefined,
        })),
      };
      const item = gaps.get(workspaceId);
      if (item) item.update(state);
      else gaps.set(workspaceId, add.call(host, { id: "sync-asks", workspaceId, title: "Status", EntryComponent: SyncAsksEntry, ...state }));
    }
    for (const [workspaceId, item] of gaps) {
      if (gapCards.has(workspaceId)) continue;
      item.remove();
      gaps.delete(workspaceId);
    }
  };

  void refresh().catch(() => undefined);
  const timer = setInterval(() => void refresh().catch(() => undefined), POLL_MS * 2);
  return () => {
    stopped = true;
    clearInterval(timer);
    for (const item of [...items.values(), ...gaps.values()]) item.remove();
    items.clear();
    gaps.clear();
  };
}
