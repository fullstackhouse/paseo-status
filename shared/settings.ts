import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const ChatCardsSchema = z.enum(["expanded", "collapsed", "hidden"]);
/** How a status_set call shows in the agent's chat. The Status panel and composer pill show cards either way. */
export type ChatCards = z.infer<typeof ChatCardsSchema>;

export const CHAT_CARD_OPTIONS: readonly { label: string; value: ChatCards }[] = [
  { label: "Expanded", value: "expanded" },
  { label: "Collapsed", value: "collapsed" },
  { label: "Hidden", value: "hidden" },
];

export const chatSettings = defineSettings({
  id: "chat",
  scope: "host",
  version: 1,
  schema: z.object({ cards: ChatCardsSchema.default("expanded") }),
});

/** The stored choice, or undefined when the document is missing a valid value. */
export function chatCardsOf(values: unknown): ChatCards | undefined {
  const parsed = chatSettings.schema.safeParse(values);
  return parsed.success ? parsed.data.cards : undefined;
}
