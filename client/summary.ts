import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import type { ComponentType } from "react";
import { agentCard, type Backing, listStatuses, runsReply, newestCard, workspaceOverviewStatus, type AgentCard, type OverviewStatus, type Status } from "../shared/status";
import { age, POLL_MS, STATE_LABELS, SyncAsksEntry } from "./StatusView";

// COMPAT(workspaceSummaryItem): FSH hosts have addWorkspaceSummaryItem (`status` from fullstackhouse/paseo's
// Overview v2, `cards` from its workspace attention, fullstackhouse/paseo#268), but the npm SDK pin doesn't
// type them yet. Hosts before `cards` drop it and group the workspace by its turn.
// Older hosts lack it; Status then only shows its pills.
interface SummaryState {
  label?: string;
  panelId?: string;
  /**
   * The newest card, shown as the Overview's Status card, with the workspace's newest goal and, while
   * blocked, what it waits on. Older hosts drop the field (and hosts before `goal`/`blockedBy`, those).
   */
  status?: OverviewStatus | null;
  /** Every agent's card as facts: Paseo decides from them, with Asks' items, whether the workspace needs you. */
  cards?: AgentCard[];
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
 * One summary item per workspace with a card: its newest card for the Overview's Status section, and every
 * card as facts for Paseo's workspace attention. Paseo decides; this sends no `workState` or `needsYou`. When
 * Paseo finds a card waiting on the human with no ask recording what, it shows a Your move row through
 * `EntryComponent`, with the agent as the entry.
 */
export function contributeWorkspaceSummaries(client: PluginClientContext): () => void {
  const host = client as PluginClientContext & SummaryHost;
  const add = host.addWorkspaceSummaryItem;
  if (!add) return () => undefined;
  const items = new Map<string, SummaryRegistration>();
  let stopped = false;

  const refresh = async () => {
    // Only the server sees what backs a card: child agents and background work.
    const { statuses, agents, backing = {}, blockers = {} } = await client.rpc(listStatuses, { withBacking: true });
    if (stopped) return;
    const running = (agentId: string) => runsReply(agents[agentId]);
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
        status: workspaceOverviewStatus(cards, running, blockers),
        cards: cards.map((card) => agentCard(card, backing[card.agentId] ?? fallbackBacking(agents[card.agentId]))),
      };
      const item = items.get(workspaceId);
      if (item) item.update(state);
      else items.set(workspaceId, add.call(host, { id: "status", workspaceId, title: "Status", EntryComponent: SyncAsksEntry, ...state }));
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

/** What backs a card when the server sent no backing (a host without it): the agent's own turn. */
function fallbackBacking(agent: { running: boolean; pluginTurn?: boolean } | undefined): Backing {
  const running = agent?.running ?? false;
  return { running, live: running, ...(agent?.pluginTurn ? { pluginTurn: true } : {}) };
}
