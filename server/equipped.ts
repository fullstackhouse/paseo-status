import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Agents created while this plugin was installed: they got the status MCP server. Kept on disk. */
export class Equipped {
  private readonly path: string;
  private readonly ids: Set<string>;

  constructor(root: string) {
    this.path = join(root, "equipped.json");
    this.ids = new Set(existsSync(this.path) ? (JSON.parse(readFileSync(this.path, "utf8")) as string[]) : []);
  }

  add(agentId: string): void {
    if (this.ids.has(agentId)) return;
    this.ids.add(agentId);
    writeFileSync(this.path, JSON.stringify([...this.ids]));
  }

  has(agentId: string): boolean {
    return this.ids.has(agentId);
  }
}
