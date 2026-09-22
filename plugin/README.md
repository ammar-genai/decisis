# decisis plugin

Typed decisions as tools for Claude Code: `/route`, `/classify`, `/triage`, plus the `typed-decisions` skill.

## Install

```
/plugin marketplace add ammar-genai/decisis
/plugin install decisis
```

The plugin runs the MCP server from this repository, which needs its dependencies once:

```sh
cd ~/.claude/plugins/marketplaces/decisis && npm install
```

Set `OPENROUTER_API_KEY` in your environment before starting Claude Code - **or skip the key entirely** and let the server answer through your Claude subscription by editing the plugin's `.mcp.json` env to `{"DECISIS_DECIDER": "claude", "DECISIS_MODEL": "sonnet"}`. Slower (seconds, not milliseconds) and it draws on your plan's usage window, but nothing else to set up.

Once the packages are published to npm this step goes away: the server will run with `npx -y @decisis/mcp`.

## What the tools do

| Tool | Answers |
|---|---|
| `classify` | One option from a named set, with confidence. A `ladder` resolves a low-confidence answer towards the safer end. |
| `decide` | Several typed questions at once: a probability, a choice, a level on a scale. |
| `route_model` | The cheapest model tier that will do a task well, raised for risk or ambiguity. |
