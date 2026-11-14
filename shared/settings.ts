import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const experimentSettings = defineSettings({
  id: "experiments",
  scope: "host",
  version: 1,
  // On: a working card holds Working only while live work backs it (5 min grace), and an idle parent whose
  // children all stopped is prompted once. Off: a working card holds Working for a day, nobody is prompted.
  schema: z.object({ liveBackedWorking: z.boolean().default(false) }),
});
