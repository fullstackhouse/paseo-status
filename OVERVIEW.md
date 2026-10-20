Status puts a short, plain-language summary of where each agent's work stands on a card you can read without opening its chat. It replaces asking an agent "tldr, where are we?" and scrolling for the answer.

## How it works

Every agent created after the plugin is installed gets a `status` MCP server with one tool, `status_set`. The server's instructions tell the agent to call it at the end of any turn that changed where things stand. A status has a one or two sentence summary, what the agent is doing now, what is done with its proof, what is next, and a state: working, waiting on you, blocked or done. Each call replaces the previous status.

## Where you see it

- Inline in the agent's chat, where it called `status_set`: the latest one is the live card, earlier ones show what they said then, collapsed.
- A pill in each agent's composer with the card's state and age. Pressing it shows the card in a popover.
- A **Status** row in the sidebar with how many agents are waiting on you or blocked, opening a screen with every workspace's cards.
- A **Status** panel in each workspace, with one card per agent, as a tab or in the Explorer.
- `/paseo-status` in an agent's composer asks that agent to update its card and opens the panel.

Each card says how long ago it was updated and how many turns have ended since, so a status the agent forgot to update is visible as such. Opening the panel asks agents with stale cards for an update, once per update. **Refresh** asks every agent whose card is behind, including agents with no card yet. If an agent is in the middle of a turn, the request waits until the turn ends, so it never interrupts. If the Asks plugin is installed, the card also lists that agent's open asks as "Your move".

## Limits

- Agents created before the plugin was installed do not have the tool. When asked, they put the status in a block at the end of their reply, and the plugin reads it from there.
- A status is only as current as the agent's last update. The only transcript text the plugin reads is a status block it asked for.
- Statuses are stored as JSON under `~/.paseo/plugin-data/status/` on the daemon machine. Nothing leaves it.
- Cards refresh every few seconds rather than instantly.
