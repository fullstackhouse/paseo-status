import { agents, statuses, waiting, workspaces } from "../fixtures";

type Contract = { name: string };

export function useRpc(contract: Contract) {
  return async (input: any): Promise<any> => {
    if (contract.name === "status.list") {
      return { statuses: statuses.filter((status) => !input.workspaceId || status.workspaceId === input.workspaceId), waiting };
    }
    return { sent: true };
  };
}

export function useWorkspace<T>(id: string, select: (workspace: { name: string; title: string | null }) => T): T {
  return select({ name: workspaces[id] ?? id, title: workspaces[id] ?? null });
}

export function useAgent<T>(id: string, select: (agent: { title: string | null; status: string }) => T): T {
  return select({ title: agents[id] ?? null, status: id === "agent-search" ? "running" : "idle" });
}
