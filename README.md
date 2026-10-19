# paseo-status

A [Paseo](https://paseo.sh) plugin: each agent keeps a plain-language status card (tldr, now, done with proof, next) that you read instead of asking "where are we?".

See [OVERVIEW.md](./OVERVIEW.md) for what it does and [AGENTS.md](./AGENTS.md) for how it is built.

```bash
npm install
npm run typecheck && npm test
paseo plugin install "$PWD"
```

Pairs with [paseo-asks](https://github.com/fullstackhouse/paseo-asks): when both are installed, a card lists the agent's open asks.
