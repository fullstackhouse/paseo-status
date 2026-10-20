import { agents, silent, statuses, waiting, workspaces } from "../fixtures";

type Contract = { name: string };

export function useRpc(contract: Contract) {
  return async (input: any): Promise<any> => {
    if (contract.name === "status.list") {
      return {
        statuses: statuses.filter((status) => !input.workspaceId || status.workspaceId === input.workspaceId),
        waiting,
        silent: input.workspaceId === "api" ? silent : [],
        agents: Object.fromEntries(Object.entries(agents).map(([id, title]) => [id, { title, running: id === "agent-search" }])),
        workspaces,
      };
    }
    if (contract.name === "status.refresh-all") return { asked: 0 };
    return { sent: true };
  };
}
