import type { Backing, Status } from "../shared/status";

/** Set by Paseo on agents created with the `create_agent` MCP tool. */
export const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";

/** A non-archived agent on this host, in any workspace. */
export interface LiveAgent {
  id: string;
  running: boolean;
  parentAgentId: string | null;
}

export interface Assessment {
  /** For every card's agent. */
  backing: Map<string, Backing>;
  /** Idle agents with a working card whose last live descendant just stopped: prompt each once. */
  wake: string[];
}

/**
 * Decides what backs each `working` card: the agent running, its background work, or any descendant
 * agent (by parent link, recursively, in any workspace) running or with background work. Remembers when
 * live work was last seen (for the grace period) and whether descendants were live, so the moment the
 * last one stops while the parent sits idle yields exactly one wake-up. State is in memory only.
 */
export class Liveness {
  private readonly lastLive = new Map<string, number>();
  /** Per agent with a working card: a descendant was live while the agent itself was not running. */
  private readonly awaitingDescendants = new Map<string, boolean>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly hasBackgroundWork: (agentId: string) => Promise<boolean>,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** The agent's own turn ended: whatever its children did meanwhile, it has seen. */
  turnEnded(agentId: string): void {
    this.awaitingDescendants.delete(agentId);
  }

  /**
   * One assessment at a time, each loading its own snapshot when its turn comes, so a slow, older
   * snapshot can never overwrite a newer one and re-arm a wake-up.
   */
  assess(load: () => Promise<{ agents: readonly LiveAgent[]; statuses: readonly Status[] }>): Promise<Assessment> {
    const run = this.queue.then(async () => {
      const { agents, statuses } = await load();
      return this.assessNow(agents, statuses);
    });
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
    const live = async (agentId: string) => (byId.get(agentId)?.running ?? false) || (byId.has(agentId) && (await busy(agentId)));
    const anyDescendantLive = async (agentId: string) => {
      const seen = new Set([agentId]);
      const queue = [...(children.get(agentId) ?? [])];
      while (queue.length > 0) {
        const id = queue.shift()!;
        if (seen.has(id)) continue;
        seen.add(id);
        if (await live(id)) return true;
        queue.push(...(children.get(id) ?? []));
      }
      return false;
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
      const self = running || (agent ? await busy(status.agentId) : false);
      const descendants = await anyDescendantLive(status.agentId);
      if (self || descendants) this.lastLive.set(status.agentId, now);
      const was = this.awaitingDescendants.get(status.agentId) ?? false;
      if (agent && was && !descendants && !self) wake.push(status.agentId);
      // Running, the agent sees its children itself; with its own background work still live, keep waiting.
      if (running) this.awaitingDescendants.set(status.agentId, false);
      else if (descendants || !self) this.awaitingDescendants.set(status.agentId, descendants);
      backing.set(status.agentId, { running, live: self || descendants, lastLiveAt: this.lastLive.get(status.agentId) });
    }
    for (const agentId of this.awaitingDescendants.keys()) if (!working.has(agentId)) this.awaitingDescendants.delete(agentId);
    return { backing, wake };
  }
}
