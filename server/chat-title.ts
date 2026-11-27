import type { PaseoApi } from "@getpaseo/client";

// COMPAT(pluginChatTitles): FSH hosts give agent handles `setAutomaticTitle` (`features.pluginChatTitles`,
// fullstackhouse/paseo#299); the npm SDK doesn't type it, and plugins can't read the host's features. Older hosts
// lack the method, so their agents get no title field and no chat is named there.
interface AutomaticTitler {
  setAutomaticTitle?(title: string, requestId?: string): Promise<{ applied: boolean }>;
}

/** Whether this host lets a plugin name a chat. */
export function hostNamesChats(api: PaseoApi): boolean {
  return typeof (api.agents.ref("") as unknown as AutomaticTitler).setAutomaticTitle === "function";
}

/**
 * Names the agent's chat from its status card. Returns whether the title landed: the host keeps a title someone
 * renamed by hand or passed when creating the chat.
 */
export async function setAutomaticTitle(api: PaseoApi, agentId: string, title: string): Promise<boolean> {
  const handle = api.agents.ref(agentId) as unknown as AutomaticTitler;
  if (typeof handle.setAutomaticTitle !== "function") return false;
  return (await handle.setAutomaticTitle(title)).applied;
}

/** `nameChat` for the status service: a missing daemon session rejects, so the caller's catch keeps the card. */
export function chatNamer(api: () => PaseoApi): (agentId: string, title: string) => Promise<boolean> {
  return async (agentId, title) => setAutomaticTitle(api(), agentId, title);
}
