# paseo-status

Paseo plugin: agents publish where their work stands via one MCP tool (`status_set`); Paseo shows it as a card per agent, with staleness and a Refresh button.

## Layout

- `index.server.ts` wires everything. `server/`: `store` (one JSON per workspace, keyed by agent; counts turns since the last update), `service` (the MCP tool, agent instructions, refresh held until the turn ends, automatic refresh of stale cards on panel open, `paseo-status` reply-block fallback for agents created before install, read-only view of the asks plugin's open asks), `equipped` (agents created while installed, so they have the tool), `bridge` (stdio MCP script written to the data dir), `listener` (localhost HTTP the bridge calls), `agents` (agentId → workspaceId).
- `client/` + `index.client.tsx`: React Native only (runs on mobile). Colors from `theme.colors`.
- `shared/status.ts`: Zod schemas and RPC contracts.
- `preview/`: own package.json; renders `client/` with react-native-web and mocked host modules for the README screenshots (`docs/*.png`). Not shipped.
- `bridge`, `listener`, `agents` are copied from `paseo-asks`. Fix a bug in one, fix it in both.

## Load-bearing facts (Paseo 0.12)

- The stdio bridge inherits `PASEO_AGENT_ID` from the agent process; that is how a tool call knows its caller.
- `agents.ref(id).send()` interrupts a running turn, so Refresh waits for `agent.turn_ended` when the agent is running.
- Plugin server code cannot write settings, so clients poll (`POLL_MS`).
- Claude plan mode prompts even for preapproved MCP tools; the server auto-allows `mcp__status__*`.
- `before("agent.session_open")` can change env only, not MCP servers: agents created before install never get the tool, hence the reply-block fallback.
- `useAgent`/`useWorkspace` throw outside a workspace panel (screens, popovers): names come from the server in `status.list`. The preview mocks don't provide them, so a regression fails there too.
- Plugin RPC names must match `/^[a-z][a-z0-9._-]*$/` (no camelCase).
- Reads `~/.paseo/plugin-data/asks/workspaces/*.json` for open asks; never writes there.

## Commands

- `npm run typecheck`, `npm test`.
- Refresh an agent from a terminal: POST `/refresh` `{"agentId": "..."}` on the port in `~/.paseo/plugin-data/status/server.json` with its bearer token.
- After edits: `paseo plugin reload paseo-status`, then `paseo plugin ls` must say `running`; logs via `paseo plugin logs paseo-status`. Never restart the daemon.
