Status puts a short, plain-language summary of where each agent's work stands on a card you can read without opening its chat. It replaces asking an agent "tldr, where are we?" and scrolling for the answer.

## How it works

Every agent created after the plugin is installed gets a `status` MCP server with one tool, `status_set`. The server's instructions tell the agent to call it at the end of any turn that changed where things stand. A status has a goal (the whole job and its overall progress, kept until the agent sends a new one), a one or two sentence summary of where things stand now, what the agent is doing now, what is done with its proof, what is next, and a state: working, waiting on you, blocked or done. A done status can't list next steps: finished work that you still have to test or merge says waiting on you, because Paseo offers Archive for a done workspace. Each call replaces the previous status, except the goal when the call leaves it out.

## Where you see it

- Inline in the agent's chat, where it called `status_set`: the latest one is the live card, earlier ones show what they said then, collapsed.
- A pill in each agent's composer with the card's state and age. Pressing it shows the card in a popover.
- A **Status** row in the sidebar with how many agents are waiting on you, opening a screen with every workspace's cards.
- A **Status** row in each workspace's Overview tab. Paseo also gets every card as facts (state, when it was written, whether you already replied, and what live work backs it) and decides from them, together with your open asks, whether the workspace needs you, is working, blocked or done. When a card says it waits on you but no ask records what, the Overview names the agent under Your move with **Sync asks**.
- A **Status** panel in each workspace, with one card per agent, as a tab or in the Explorer.
- `/paseo-status` in an agent's composer asks that agent to update its card and opens the panel.

Each card says how long ago it was updated and how many turns have ended since, so a status the agent forgot to update is visible as such. Opening the panel asks agents with stale cards for an update, once per update. **Refresh** asks every agent whose card is behind, including agents with no card yet. If an agent is in the middle of a turn, the request joins that turn when its provider allows it, and otherwise waits until the turn ends, so it never interrupts.

## Limits

- Agents created before the plugin was installed do not have the tool. When asked, they put the status in a block at the end of their reply, and the plugin reads it from there.
- A status is only as current as the agent's last update. The only transcript text the plugin reads is a status block it asked for.
- Statuses are stored as JSON under `~/.paseo/plugin-data/status/` on the daemon machine. Nothing leaves it.
- Cards refresh every few seconds rather than instantly.
