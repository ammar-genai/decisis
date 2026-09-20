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

Set `OPENROUTER_API_KEY` in your environment before starting Claude Code.

Once the packages are published to npm this step goes away: the server will run with `npx -y @decisis/mcp`.

## What the tools do

| Tool | Answers |
|---|---|
| `classify` | One option from a named set, with confidence. A `ladder` resolves a low-confidence answer towards the safer end. |
| `decide` | Several typed questions at once: a probability, a choice, a level on a scale. |
| `route_model` | The cheapest model tier that will do a task well, raised for risk or ambiguity. |
