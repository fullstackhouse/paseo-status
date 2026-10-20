import { StatusInputSchema, type Status, type StatusInput } from "./status";

/** The plugin timeline item that stands in for a status_set call: the status that call published. */
export const STATUS_CARD = { kind: "status-card", version: 1 } as const;

export const StatusCardSchema = StatusInputSchema;
export type StatusCard = StatusInput;

/** The parts of a `tool_call` timeline item this reads. */
export interface ToolCallLike {
  name: string;
  status: string;
  detail: { type: string; input?: unknown; output?: unknown };
}

// Claude names it mcp__status__status_set; other providers join server and tool differently.
const TOOL = /status.*status_set$/;
// The tool result on success (see callTool() in server/service.ts); errors return other text.
const PUBLISHED = "Status published";

/** The card to show instead of a status_set call, or undefined to keep the row as it is (running, failed, other tools). */
export function statusCardFor(item: ToolCallLike): StatusCard | undefined {
  if (!TOOL.test(item.name) || item.status !== "completed") return undefined;
  const { input, output } = item.detail;
  // The output is a string or an MCP content array depending on the provider; search it as text.
  const text = typeof output === "string" ? output : JSON.stringify(output ?? "");
  if (!text.includes(PUBLISHED)) return undefined;
  const parsed = StatusInputSchema.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}

/** The live status is still the one this card published, so the card shows it live rather than as history. */
export function isCurrent(card: StatusCard, live: Status | undefined): boolean {
  if (!live) return false;
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((item, index) => item === b[index]);
  return (
    card.state === live.state &&
    card.tldr === live.tldr &&
    (card.now ?? "") === (live.now ?? "") &&
    same(card.done, live.done) &&
    same(card.next, live.next)
  );
}
