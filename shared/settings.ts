import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/** Host-wide: whether agents name their chat from the status card. Read when an agent is created and on each status_set. */
export const chatTitleSettings = defineSettings({
  id: "chat-titles",
  scope: "host",
  version: 1,
  schema: z.object({
    nameChats: z.boolean().default(false),
  }),
});
