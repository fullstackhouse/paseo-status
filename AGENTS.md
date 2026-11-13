# paseo-status

Paseo plugin: agents publish where their work stands via one MCP tool (`status_set`); Paseo shows it as a card per agent, with staleness and a Refresh button.

## Layout

- `index.server.ts` wires everything. `server/`: `store` (one JSON per workspace, keyed by agent; counts turns since the last update), `service` (the MCP tool, agent instructions, refresh held until the turn ends, automatic refresh of stale cards on panel open, `paseo-status` reply-block fallback for agents created before install, read-only view of the asks plugin's open asks), `equipped` (agents created while installed, so they have the tool), `bridge` (stdio MCP script written to the data dir), `listener` (localhost HTTP the bridge calls), `agents` (agentId → workspaceId; caller by cwd for Codex), `permissions` (which tool prompts to auto-allow).
- `client/` + `index.client.tsx`: React Native only (runs on mobile). Colors from `theme.colors`.
- `client/RowBadge.tsx`: the sidebar workspace row badge (needs you / working / done) from `status.summary`, which `summarize` in `shared/status.ts` computes from cards, open asks, and live agents. Registered only when the host has `addWorkspaceRowItem` (newer than SDK 0.12, typed locally until the SDK ships it).
- `client/summary.ts`: one workspace summary item per workspace with a card (Overview tab label, and `workState` for Paseo's agent-reported sidebar grouping, from `workspaceWorkState` in `shared/status.ts`). Never sets `needsYou` (a card waiting on the human reports `workState: "waiting"`), so it never opens Explorer.
- `shared/status.ts`: Zod schemas and RPC contracts. `shared/timeline.ts`: turns a completed `status_set` tool row into an inline chat card (snapshot from the call's input; live when it still matches the stored status). `paseo-status` reply blocks are not transformed: transformers emit only plugin items, so it would mean replacing the whole reply.
- `preview/`: own package.json; renders `client/` with react-native-web and mocked host modules for the README screenshots (`docs/*.png`). Not shipped.
- `bridge`, `listener`, `agents`, `permissions` and `host-sdk` are copied from `paseo-asks`. Fix a bug in one, fix it in both.

## Load-bearing facts (Paseo 0.12)

- Background workspaces (`workspace.background`, e.g. Inbox runs before the human opens them) get no status cards: `status_set` returns `BACKGROUND_SKIP` and stores nothing, and Refresh all skips them. The tool stays, because an agent's tools are fixed at creation and the human may take the run over.
- The stdio bridge inherits `PASEO_AGENT_ID` from the agent process; that is how a tool call knows its caller. Codex drops it, so the bridge also sends its cwd and `pickCaller` picks the running agent there.
- `agent.turn_ended` carries no history: its `timeline` has been empty since Paseo 0.15 (getpaseo/paseo#7477). Read the turn with the host's `latestTurn` (`@getpaseo/plugin/server`, FSH hosts from `0bd77c5`; typed locally in `server/host-sdk.ts` until the npm SDK has it).
- `agents.ref(id).send()` interrupts a running turn, so Refresh waits for `agent.turn_ended` when the agent is running.
- Plugin server code cannot write settings, so clients poll (`POLL_MS`).
- Claude plan mode prompts even for preapproved MCP tools, and Codex asks to approve every MCP call (`CodexMcpElicitation`); the server auto-allows both for the status server.
- Codex (0.166) defers every MCP tool behind its tool search, with the server instructions only in the deferred descriptions; `alwaysLoad` works for Claude only. Without the host telling Codex to look them up (FSH hosts from `e319bb8`, fullstackhouse/paseo#93), Codex agents never call `status_set` on their own.
- `before("agent.session_open")` can change env only, not MCP servers: agents created before install never get the tool, hence the reply-block fallback.
- `useAgent`/`useWorkspace` throw outside a workspace panel (screens, popovers): names come from the server in `status.list`. The preview mocks don't provide them, so a regression fails there too.
- Plugin RPC names must match `/^[a-z][a-z0-9._-]*$/` (no camelCase).
- Reads `~/.paseo/plugin-data/asks/workspaces/*.json` for open asks; never writes there.

## Commands

- `npm run typecheck`, `npm test`.
- `npm run e2e`: real Paseo daemon (the FSH CLI bundle that `e2e/fsh-host.mjs` downloads by tag and sha256 before each run, since the plugin needs FSH-only host exports; `e2e/` pins Claude Code and Codex) in a temp `--home` and `HOME`, plugin installed, agents answered from `e2e/cassettes/` by a local proxy: Haiku via `ANTHROPIC_BASE_URL` (Messages API), Codex `gpt-5.6-luna` via a `model_provider` in the sandbox's `~/.codex/config.toml` (Responses API over HTTP/SSE). No network, runs in CI. `unprompted.e2e.ts` gives an ordinary task that never mentions status and expects a card anyway: the other scenarios tell the agent to call `status_set`, so they only test the wiring. `PASEO_HOST_SRC=<paseo checkout>` (built with `npm run build:server`) runs on that checkout instead of the pinned tag, to test against a host change before it is released. After changing a scenario or anything the model sees (instructions, prompts, tool output), re-record: `npm run e2e:record` with `OPENROUTER_API_KEY` in the env or `e2e/.env` (the proxy adds it; agents only see a dummy key), then commit the cassette. A replay miss fails the run and lists the unmatched request. `e2e/proxy.ts` and `e2e/fsh-host.mjs` are shared with `paseo-asks`: keep them self-contained and copy changes across.
- Refresh an agent from a terminal: POST `/refresh` `{"agentId": "..."}` on the port in `~/.paseo/plugin-data/status/server.json` with its bearer token.
- After edits: `paseo plugin reload paseo-status`, then `paseo plugin ls` must say `running`; logs via `paseo plugin logs paseo-status`. Never restart the daemon.
