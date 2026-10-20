import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Status } from "../shared/status";

type WorkspaceFile = Record<string, Status>;

export type StatusInput = Pick<Status, "state" | "tldr" | "now" | "done" | "next">;

/** One JSON file per workspace, keyed by agent. Single writer (the plugin process). */
export class StatusStore {
  private readonly dir: string;
  private readonly cache = new Map<string, WorkspaceFile>();
  /** agentId → workspaceId for every status loaded, so turn hooks need no lookup. */
  private readonly owners = new Map<string, string>();

  constructor(root: string, private readonly now: () => Date = () => new Date()) {
    this.dir = join(root, "workspaces");
    mkdirSync(this.dir, { recursive: true });
    for (const id of this.workspaceIds()) this.read(id);
  }

  list(workspaceId?: string): Status[] {
    const ids = workspaceId ? [workspaceId] : this.workspaceIds();
    return ids.flatMap((id) => Object.values(this.read(id))).filter((status) => !status.archived);
  }

  get(agentId: string): Status | undefined {
    const workspaceId = this.owners.get(agentId);
    return workspaceId ? this.read(workspaceId)[agentId] : undefined;
  }

  set(workspaceId: string, agentId: string, input: StatusInput): Status {
    const previous = this.get(agentId);
    return this.write(workspaceId, agentId, {
      ...input,
      agentId,
      workspaceId,
      updatedAt: this.now().toISOString(),
      turnsSince: 0,
      setThisTurn: true,
      refreshPending: previous?.refreshPending,
    });
  }

  /** Bookkeeping that does not count as the agent updating its status. */
  patch(agentId: string, patch: Partial<Pick<Status, "turnsSince" | "setThisTurn" | "refreshPending" | "refreshRequestedAt" | "archived">>): Status | undefined {
    const current = this.get(agentId);
    if (!current) return undefined;
    return this.write(current.workspaceId, agentId, { ...current, ...patch });
  }

  /** Counts the turn as stale unless the agent set its status during it. */
  turnEnded(agentId: string): Status | undefined {
    const current = this.get(agentId);
    if (!current) return undefined;
    return this.patch(agentId, current.setThisTurn ? { setThisTurn: false } : { turnsSince: current.turnsSince + 1 });
  }

  private write(workspaceId: string, agentId: string, status: Status): Status {
    const file = { ...this.read(workspaceId), [agentId]: status };
    const path = this.path(workspaceId);
    writeFileSync(`${path}.tmp`, JSON.stringify(file, null, 2));
    renameSync(`${path}.tmp`, path);
    this.cache.set(workspaceId, file);
    this.owners.set(agentId, workspaceId);
    return status;
  }

  private workspaceIds(): string[] {
    return readdirSync(this.dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => decodeURIComponent(name.slice(0, -".json".length)));
  }

  private path(workspaceId: string): string {
    return join(this.dir, `${encodeURIComponent(workspaceId)}.json`);
  }

  private read(workspaceId: string): WorkspaceFile {
    const cached = this.cache.get(workspaceId);
    if (cached) return cached;
    const path = this.path(workspaceId);
    const file: WorkspaceFile = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
    this.cache.set(workspaceId, file);
    for (const agentId of Object.keys(file)) this.owners.set(agentId, workspaceId);
    return file;
  }
}
