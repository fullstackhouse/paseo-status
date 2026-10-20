import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";

/** A prompt to run the status tool: Claude names the tool, Codex asks to approve the MCP server's call. */
export function isStatusPermission(request: Pick<AgentPermissionRequest, "kind" | "name" | "metadata">): boolean {
  if (request.kind !== "tool") return false;
  if (request.name.startsWith("mcp__status__")) return true;
  return request.name === "CodexMcpElicitation" && request.metadata?.serverName === "status";
}
