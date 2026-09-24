# @decisis/mcp

**Typed decisions as MCP tools.** Three tools any agent that speaks MCP can call when it needs a fast, cheap, auditable answer instead of a paragraph of prose: classify this, answer these typed questions, route this task to a model tier.

A model proposes, rules you can read decide, and every answer comes back with its reasons, its latency and its cost.

## Run it

The server speaks MCP over stdio. In a Claude Code project, add it to `.mcp.json`:

```json
{
  "mcpServers": {
    "decisis": {
      "command": "npx",
      "args": ["-y", "@decisis/mcp"],
      "env": { "OPENROUTER_API_KEY": "${OPENROUTER_API_KEY}" }
    }
  }
}
```

Until the packages are on npm, clone the repository, run `npm install` once, and point `command`/`args` at `node <clone>/packages/mcp/src/server.ts` instead. The [plugin](../../plugin) does this for you and adds `/route`, `/classify` and `/triage`.

## Configuration

| Variable | Meaning |
|---|---|
| `DECISIS_DECIDER` | `jev` (default), `claude`, or `llm` |
| `OPENROUTER_API_KEY` | Required for `jev` and `llm`. Not read at all for `claude`. |
| `DECISIS_MODEL` | The model for the chosen decider. Defaults to Jev 1.13 for `jev` and `haiku` for `claude`; required for `llm`. |

**No API key?** Set `DECISIS_DECIDER=claude` and the server answers through the Claude Code CLI on your existing subscription. Use `DECISIS_MODEL=sonnet`: asked which model a task needs, Haiku tends to choose itself, so judge with a tier above the cheapest one you might pick. Expect seconds rather than milliseconds.

## The tools

### `classify`

One option out of a named set, with confidence.

| Argument | Required | Meaning |
|---|---|---|
| `state` | yes | The text or JSON to classify |
| `options` | yes | Option name to what that option means. At least two. |
| `instructions` | no | The question to answer |
| `ladder` | no | The same option names ordered least to most cautious |
| `confidence_floor` | no | Below this, the ladder resolves to the safer option. Default 0.6. |

Pass a `ladder` when the options differ in how cautious they are. A low-confidence answer then resolves to the safer of the model's top two, and the result says so: `value`, `proposed`, `confidence`, `probabilities`, `reasons`.

### `decide`

Several typed questions about one state, answered at once. Each question is a `noul` (a probability), a `choice` (one option from `criteria`), or a `score` (a level on an ordered list). Invalid questions come back as a tool error naming the question, not a crash.

### `route_model`

The cheapest model tier that will do a coding task well, raised when the work is risky or under-specified. Tiers default to `haiku < sonnet < opus` and can be renamed with `tiers`.

Three floors apply, and floors only ever raise:

- Risk **High** means at least the strongest tier.
- Risk **Medium** means at least the middle tier.
- Ambiguity above 0.6, meaning the task needs design decisions it does not specify, means at least the middle tier.

Returns `tier`, `proposed`, `raised`, `risk`, `ambiguity` and the `reasons` behind the choice.

## Measured

Live, through this server:

| Call | Answer | Latency | Cost |
|---|---|---|---|
| A CI failure reading "connection reset talking to the artifact registry" | `infra` | 300 ms | $0.000015 |
| "Add a /health endpoint with a test" | `sonnet` | 374 ms | — |

On a 30-task labelled routing set, Jev plus these floors scored 90/90 acceptable with zero under-routing, and would have spent 49% of an all-opus run in model price units. That evaluation scores agreement with hand-written labels and does not execute the tasks, so it measures routing agreement rather than delivered outcomes or real spend. The set ships in [`@decisis/router`](../router) so you can re-run it yourself.

## Failure behaviour

A provider failure is returned as a tool error carrying the reason, never raised as a crash, so a broken key or a rate limit shows up in the client as a readable message. Tests drive the server over a real stdio transport with an injected decider, so they never touch the network.

## Licence

MIT
