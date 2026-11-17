import type { PaseoApi } from "@getpaseo/client";

// COMPAT(workspaceAttentionReport): FSH hosts send `snoozedAt` on workspaces and give workspace handles
// `reportNeedsYou` (`features.workspaceAttentionReport`); the npm SDK types neither. Hosts without
// snooze omit `snoozedAt`, and hosts without the report lack the method, so nothing is reported there.
interface SnoozableWorkspace {
  readonly id: string;
  readonly snoozedAt?: string | null;
}
interface NeedsYouReporter {
  reportNeedsYou?(options: { agentId?: string }): Promise<{ woke: boolean }>;
}

/** Snoozed workspaces with when their snooze began. The daemon clears `snoozedAt` when a snooze ends. */
export async function snoozedWorkspaces(api: PaseoApi): Promise<Array<{ id: string; snoozedAt: string }>> {
  const found: Array<{ id: string; snoozedAt: string }> = [];
  let cursor: string | undefined;
  do {
    const { entries, pageInfo } = await api.workspaces.list({ page: { limit: 200, cursor } });
    for (const workspace of entries as readonly SnoozableWorkspace[]) {
      if (workspace.snoozedAt) found.push({ id: workspace.id, snoozedAt: workspace.snoozedAt });
    }
    cursor = pageInfo.hasMore ? (pageInfo.nextCursor ?? undefined) : undefined;
  } while (cursor);
  return found;
}

/**
 * Tells the host the workspace needs the human. It follows the host's setting for snoozed workspaces
 * (wake and notify by default) and announces `agentId`'s finished turn, which the snooze kept quiet.
 */
export async function reportNeedsYou(api: PaseoApi, workspaceId: string, agentId: string): Promise<boolean> {
  const handle = api.workspaces.ref(workspaceId) as unknown as NeedsYouReporter;
  if (!handle.reportNeedsYou) return false;
  return (await handle.reportNeedsYou({ agentId })).woke;
}
