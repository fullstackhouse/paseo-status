import { describe, expect, it } from "vitest";
import type { Status } from "../shared/status";
import { isCurrent, statusCardFor } from "../shared/timeline";

const call = (name: string, status: string, input?: unknown, output?: unknown) => ({
  name,
  status,
  detail: { type: "unknown", input, output },
});

const input = { state: "working", tldr: "Fixing search ranking.", now: "Running tests", done: ["Repro test"], next: ["Open PR"] };

describe("statusCardFor", () => {
  it("reads the status from the input when the result is a string", () => {
    expect(statusCardFor(call("mcp__status__status_set", "completed", input, "Status published (working)."))).toEqual(input);
  });

  it("accepts an MCP content array result and other name joins", () => {
    const output = { content: [{ type: "text", text: "Status published (working)." }] };
    expect(statusCardFor(call("status.status_set", "completed", input, output))).toEqual(input);
  });

  it("fills omitted lists", () => {
    expect(statusCardFor(call("mcp__status__status_set", "completed", { state: "done", tldr: "Shipped." }, "Status published (done).")))
      .toEqual({ state: "done", tldr: "Shipped.", done: [], next: [] });
  });

  it("keeps running, failed, rejected and unrelated rows", () => {
    expect(statusCardFor(call("mcp__status__status_set", "running", input))).toBeUndefined();
    expect(statusCardFor(call("mcp__status__status_set", "failed", input, "boom"))).toBeUndefined();
    expect(statusCardFor(call("mcp__status__status_set", "completed", input, "Agent x has no workspace"))).toBeUndefined();
    expect(statusCardFor(call("mcp__status__status_set", "completed", { state: "nope", tldr: "x" }, "Status published (x)."))).toBeUndefined();
    expect(statusCardFor(call("mcp__asks__ask_create", "completed", input, "Status published"))).toBeUndefined();
  });
});

describe("isCurrent", () => {
  const live: Status = { ...input, state: "working", agentId: "a", workspaceId: "w", updatedAt: "", turnsSince: 0 };
  const card = statusCardFor(call("mcp__status__status_set", "completed", input, "Status published (working)."))!;

  it("matches the live status it published", () => {
    expect(isCurrent(card, live)).toBe(true);
  });

  it("does not match a later status or a missing one", () => {
    expect(isCurrent(card, { ...live, next: ["Open PR", "Deploy"] })).toBe(false);
    expect(isCurrent(card, { ...live, now: undefined })).toBe(false);
    expect(isCurrent(card, undefined)).toBe(false);
  });
});
