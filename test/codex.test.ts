import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import { pickCaller } from "../server/agents";
import { isStatusPermission } from "../server/permissions";

describe("isStatusPermission", () => {
  it("recognises Claude and Codex prompts for the status tool only", () => {
    expect(isStatusPermission({ kind: "tool", name: "mcp__status__status_set" })).toBe(true);
    expect(isStatusPermission({ kind: "tool", name: "CodexMcpElicitation", metadata: { serverName: "status" } })).toBe(true);
    expect(isStatusPermission({ kind: "tool", name: "CodexMcpElicitation", metadata: { serverName: "asks" } })).toBe(false);
    expect(isStatusPermission({ kind: "tool", name: "Bash" })).toBe(false);
  });
});

describe("pickCaller", () => {
  const agent = (id: string, cwd: string, status = "idle", archivedAt: string | null = null) => ({ id, cwd, status, archivedAt });
  const home = homedir();

  it("picks the agent mid-turn in the bridge's directory", () => {
    const agents = [agent("a", `${home}/w/one`), agent("b", "~/w/one", "running"), agent("c", `${home}/w/two`, "running")];
    expect(pickCaller(agents, `${home}/w/one`)).toBe("b");
  });

  it("falls back to the only live agent there, and gives up when it cannot tell", () => {
    expect(pickCaller([agent("a", "/w"), agent("b", "/w", "running", "2026-01-01")], "/w")).toBe("a");
    expect(pickCaller([agent("a", "/w"), agent("b", "/w")], "/w")).toBe(null);
    expect(pickCaller([agent("a", "/w", "running"), agent("b", "/w", "running")], "/w")).toBe(null);
  });
});
