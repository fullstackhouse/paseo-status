import type { SilentAgent, Status, Waiting } from "../shared/status";

export const workspaces: Record<string, string> = {
  api: "shop-api",
  web: "storefront",
};

export const agents: Record<string, string> = {
  "agent-giftcards": "Gift-card checkout",
  "agent-search": "Search ranking fix",
  "agent-images": "Product image resizing",
};

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

export const statuses: Status[] = [
  {
    agentId: "agent-giftcards",
    workspaceId: "api",
    state: "waiting_on_you",
    tldr: "Gift cards can now be bought and redeemed at checkout. The code is done and tested; it is waiting on your call on partial refunds before the PR goes up.",
    now: "Waiting on you to pick how partial refunds behave.",
    done: [
      "Gift card model, issue and redeem endpoints",
      "Tests pass: 42/42, including a double-spend race",
      "Committed on gift-cards; not pushed",
    ],
    next: ["Apply your refund decision", "Push and open the PR (needs your review)"],
    updatedAt: ago(6),
    turnsSince: 0,
  },
  {
    agentId: "agent-search",
    workspaceId: "api",
    state: "working",
    tldr: "Out-of-stock products were ranking first in search. The cause is found and fixed; the full test suite is running.",
    now: "Running the full test suite (about 4 minutes).",
    done: ["Reproduced it with a failing test", "Fix: stock now weighs into the score"],
    next: ["Check suite results", "Open the PR"],
    updatedAt: ago(52),
    turnsSince: 3,
  },
  {
    agentId: "agent-images",
    workspaceId: "web",
    state: "done",
    tldr: "Product images are resized on upload and served as WebP. Merged and deployed.",
    done: ["PR #7 merged, CI green", "Deployed; home page 38% lighter"],
    next: [],
    updatedAt: ago(180),
    turnsSince: 0,
  },
];

export const waiting: Waiting[] = [
  { id: "A4", title: "Partial refunds: back to the gift card or to the original card?", agentId: "agent-giftcards" },
];

export const silent: SilentAgent[] = [{ agentId: "agent-legacy", title: "Coupon code cleanup" }];
