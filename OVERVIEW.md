Status puts a short, plain-language summary of where each agent's work stands on a card you can read without opening its chat. It replaces asking an agent "tldr, where are we?" and scrolling for the answer.

## How it works

Every agent created after the plugin is installed gets a `status` MCP server with one tool, `status_set`. The server's instructions tell the agent to call it at the end of any turn that changed where things stand. A status has a one or two sentence summary, what the agent is doing now, what is done with its proof, what is next, and a state: working, waiting on you, blocked or done. Each call replaces the previous status.

## Where you see it

- **Status** panel in each workspace, with one card per agent.
- **Status** screen with every workspace's cards, from the Command Center.
- `/paseo-status` in an agent's composer asks that agent to update its card and opens the panel.

Each card says how long ago it was updated and how many turns have ended since, so a status the agent forgot to update is visible as such. **Refresh** asks the agent for an update. If the agent is in the middle of a turn, the request waits until the turn ends, so it never interrupts. If the Asks plugin is installed, the card also lists that agent's open asks as "Your move".

## Limits

- Agents created before the plugin was installed do not have the tool.
- A status is only as current as the agent's last update; the plugin does not read transcripts.
- Statuses are stored as JSON under `~/.paseo/plugin-data/status/` on the daemon machine. Nothing leaves it.
- Cards refresh every few seconds rather than instantly.
