import type { SilentAgent, Status, StatusInput } from "../shared/status";

export const workspaces: Record<string, string> = {
  api: "shop-api",
  web: "storefront",
};

export const agents: Record<string, string> = {
  "agent-giftcards": "Gift-card checkout",
  "agent-search": "Search ranking fix",
  "agent-images": "Product image resizing",
  "agent-coordinator": "Pause the overnight UI migration",
};

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

export const statuses: Status[] = [
  {
    agentId: "agent-giftcards",
    workspaceId: "api",
    state: "waiting_on_you",
    goal: "Let shoppers buy and redeem gift cards at checkout, shipped as one PR. Code and tests are done; one decision left.",
    tldr: "The code is done and tested; it is waiting on your call on partial refunds before the PR goes up.",
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
  {
    agentId: "agent-coordinator",
    workspaceId: "web",
    state: "waiting_on_you",
    tldr: "The second cleanup round is merged. Still waiting on you: merge #1543 and the list-pages scout's A205 and A207.",
    done: ["Round 2 merged: #1551, #1553, #1556"],
    next: ["You: merge #1543", "You: answer A205 and A207"],
    updatedAt: ago(20),
    turnsSince: 0,
  },
];

export const silent: SilentAgent[] = [{ agentId: "agent-legacy", title: "Coupon code cleanup" }];

/** An earlier status_set from the gift-card agent, replaced since by the live one above. */
export const earlierGiftcards: StatusInput = {
  state: "working",
  tldr: "Adding gift cards to checkout. The model and endpoints are in; redeeming at checkout is next.",
  now: "Writing the redeem endpoint.",
  done: ["Gift card model and issue endpoint"],
  next: ["Redeem at checkout", "Tests", "Open the PR"],
};
