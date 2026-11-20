import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const experimentSettings = defineSettings({
  id: "experiments",
  scope: "host",
  version: 1,
  // On: an unanswered blocked card reports the workspace as blocked (Paseo's Blocked group), not needs
  // you, and never wakes a snoozed workspace. Off: a blocked card needs you, like waiting_on_you.
  schema: z.object({ blockedGroup: z.boolean().default(false) }),
});
