import type { Backing, Status } from "../shared/status";

/** Set by Paseo on agents created with the `create_agent` MCP tool. */
export const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";

/**
 * How long a wake-up waits after the last child stops. Paseo itself prompts the parent when a child it
 * created finishes (`notifyOnFinish`, on by default, delivered after ~2 quiet seconds); that prompt starts
 * a turn, which cancels the wake. Only a parent nothing else woke gets it.
 */
export const WAKE_DELAY_MS = 60 * 1000;

/** A non-archived agent on this host, in any workspace. */
export interface LiveAgent {
  id: string;
  running: boolean;
  parentAgentId: string | null;
  /**
   * Paseo shows the agent's workspace as running. The host counts provider subagents (Claude's background
   * Task agents) and background work there, and plugin code cannot see provider subagents any other way.
   * Coarse: any agent running in that workspace counts.
   */
  workspaceBusy: boolean;
}

export interface Assessment {
  /** For every card's agent. */
  backing: Map<string, Backing>;
  /** Agents to prompt now: idle with a working card, their last live descendant stopped `WAKE_DELAY_MS` ago, and nothing has woken them since. */
  wake: string[];
}

/** Whether the agent has background work live right now, via the FSH host's `backgroundWork` on an agent handle. */
export async function hasBackgroundWork(handle: object): Promise<boolean> {
  // COMPAT(hostBackgroundWork): FSH hosts only; the npm SDK pin has no such field. Absent means none.
  const work = (handle as { backgroundWork?: { list(): Promise<readonly unknown[]> } }).backgroundWork;
  if (!work) return false;
  return (await work.list()).length > 0;
}

/**
 * Decides what backs each `working` card: the agent running, its workspace busy, its background work, or
 * any descendant agent (by parent link, recursively, in any workspace) that is. Remembers when live work
 * was last seen (for the grace period) and whether descendants were live, so the moment the last one stops
 * while the parent sits idle schedules exactly one wake-up. State is in memory only.
 */
export class Liveness {
  private readonly lastLive = new Map<string, number>();
  /** Per agent with a working card: a descendant was live while the agent itself was not running. */
  private readonly awaitingDescendants = new Map<string, boolean>();
  /** Wake-ups due once `WAKE_DELAY_MS` has passed, with the card version they were scheduled for. */
  private readonly pendingWakes = new Map<string, { since: number; updatedAt: string }>();
  private queue: Promise<unknown> = Promise.resolve();
  private queued: Promise<Assessment> | undefined;

  constructor(
    private readonly hasBackgroundWork: (agentId: string) => Promise<boolean>,
    private readonly now: () => number = () => Date.now(),
    /** Called once per wake-up that falls due, however many callers share the assessment. */
    private readonly onWake: (agentId: string) => void = () => undefined,
  ) {}

  /** The agent's own turn ended: whatever its children did meanwhile, it has seen. */
  turnEnded(agentId: string): void {
    this.awaitingDescendants.delete(agentId);
    this.pendingWakes.delete(agentId);
  }

  /** When the earliest scheduled wake-up falls due (epoch ms), if any. */
  nextWakeAt(): number | undefined {
    const due = [...this.pendingWakes.values()].map((pending) => pending.since + WAKE_DELAY_MS);
    return due.length > 0 ? Math.min(...due) : undefined;
  }

  /**
   * One assessment at a time, each loading its own snapshot when its turn comes, so a slow, older snapshot
   * can never overwrite a newer one. Callers arriving while one is queued and not yet started share it.
   */
  assess(load: () => Promise<{ agents: readonly LiveAgent[]; statuses: readonly Status[] }>): Promise<Assessment> {
    if (this.queued) return this.queued;
    const run = this.queue.then(async () => {
      this.queued = undefined;
      const { agents, statuses } = await load();
      const assessment = await this.assessNow(agents, statuses);
      for (const agentId of assessment.wake) this.onWake(agentId);
      return assessment;
    });
    this.queued = run;
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async assessNow(agents: readonly LiveAgent[], statuses: readonly Status[]): Promise<Assessment> {
    const byId = new Map(agents.map((agent) => [agent.id, agent]));
    const children = new Map<string, string[]>();
    for (const agent of agents) {
      if (!agent.parentAgentId) continue;
      const list = children.get(agent.parentAgentId);
      if (list) list.push(agent.id);
      else children.set(agent.parentAgentId, [agent.id]);
    }
    const background = new Map<string, Promise<boolean>>();
    const busy = (agentId: string): Promise<boolean> => {
      if (!background.has(agentId)) background.set(agentId, this.hasBackgroundWork(agentId).catch(() => false));
      return background.get(agentId)!;
    };
    /** Live without asking the host: running, or its workspace is. */
    const visiblyLive = (agentId: string) => {
      const agent = byId.get(agentId);
      return !!agent && (agent.running || agent.workspaceBusy);
    };
    const anyLive = async (ids: readonly string[]) =>
      ids.some(visiblyLive) || (await Promise.all(ids.filter((id) => byId.has(id)).map(busy))).some(Boolean);
    const descendantsOf = (agentId: string) => {
      const seen = new Set([agentId]);
      const found: string[] = [];
      const queue = [...(children.get(agentId) ?? [])];
      while (queue.length > 0) {
        const id = queue.shift()!;
        if (seen.has(id)) continue;
        seen.add(id);
        found.push(id);
        queue.push(...(children.get(id) ?? []));
      }
      return found;
    };

    const now = this.now();
    const backing = new Map<string, Backing>();
    const wake: string[] = [];
    const working = new Set<string>();
    for (const status of statuses) {
      if (status.archived) continue;
      const agent = byId.get(status.agentId);
      const running = agent?.running ?? false;
      if (status.state !== "working") {
        backing.set(status.agentId, { running, live: running, lastLiveAt: this.lastLive.get(status.agentId) });
        continue;
      }
      working.add(status.agentId);
      const self = await anyLive([status.agentId]);
      const descendants = await anyLive(descendantsOf(status.agentId));
      if (self || descendants) this.lastLive.set(status.agentId, now);
      backing.set(status.agentId, { running, live: self || descendants, lastLiveAt: this.lastLive.get(status.agentId) });

      const pending = this.pendingWakes.get(status.agentId);
      if (pending) {
        // Woken some other way, busy again, or it updated its card: nothing left to wake it for.
        if (!agent || self || descendants || pending.updatedAt !== status.updatedAt) this.pendingWakes.delete(status.agentId);
        else if (now - pending.since >= WAKE_DELAY_MS) {
          this.pendingWakes.delete(status.agentId);
          wake.push(status.agentId);
        }
      }
      const was = this.awaitingDescendants.get(status.agentId) ?? false;
      if (agent && was && !descendants && !self) this.pendingWakes.set(status.agentId, { since: now, updatedAt: status.updatedAt });
      // Running, the agent sees its children itself; with its own work still live, keep waiting.
      if (running) this.awaitingDescendants.set(status.agentId, false);
      else if (descendants || !self) this.awaitingDescendants.set(status.agentId, descendants);
    }
    for (const map of [this.awaitingDescendants, this.pendingWakes, this.lastLive]) {
      for (const agentId of map.keys()) if (!working.has(agentId)) map.delete(agentId);
    }
    return { backing, wake };
  }
}
