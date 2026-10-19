import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function dataDir(): string {
  const dir = process.env.PASEO_STATUS_DIR ?? join(process.env.PASEO_HOME ?? join(homedir(), ".paseo"), "plugin-data", "status");
  mkdirSync(dir, { recursive: true });
  return dir;
}
