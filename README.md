# decisis

**Typed decisions, deterministic policy, human override.** A model proposes; rules you can read decide; a person can always overrule. Built for the decision points inside software — routing, triage, classification, screening — where a fast, cheap, auditable answer beats a paragraph of prose.

Not on npm yet — clone it and `npm install`, then import from the workspace:

```ts
import { jevDecider, resolveChoice, levelOf } from '@decisis/core';

const decide = jevDecider({ key: process.env.OPENROUTER_API_KEY });

const { answers } = await decide(
  { task: { title: 'Split the orders table without downtime' } },
  {
    tier: { type: 'choice', instructions: 'Which model should do this task? Pick the cheapest that will do it well.',
            criteria: { haiku: 'Mechanical and local.', sonnet: 'Normal feature work.', opus: 'Hard or high-stakes.' } },
    risk: { type: 'score', instructions: 'How costly would a subtle mistake be?', criteria: ['Low', 'Medium', 'High'] },
  },
);

const risk = levelOf(answers.risk, ['Low', 'Medium', 'High']);
const routed = resolveChoice({
  answer: answers.tier,
  ladder: ['haiku', 'sonnet', 'opus'],
  floors: [{ to: 'opus', when: risk === 'High', why: 'risk High: at least opus' }],
});

routed.value;    // 'opus'
routed.reasons;  // ['proposed opus (confidence 0.99)']
```

About 500 ms, about $0.00002.

## Why

Agents and pipelines make the same three moves over and over: *is this worth acting on?*, *which route does it take?*, *how bad is it?* Asking a large model for prose and parsing it back is slow, expensive and unrepeatable. This library keeps that decision typed, cheap and inspectable:

- **Typed questions.** A probability, one option from a fixed set, or a level on an ordered scale. Nothing free-form to parse.
- **Policy you can read.** A model's answer is a proposal. Floors, confidence handling and fallbacks are ordinary code with recorded reasons — and they only ever move a decision towards the *safer* end of a ladder.
- **Human override.** Machine answer, human override, final answer. The rules re-run from the final answer, so a review changes the outcome instead of arguing with it.
- **Model-agnostic.** TypeSafe Jev through OpenRouter, any chat model through structured outputs, or **the Claude Code CLI on a plain subscription with no API key**. Same questions, same policy, so you can measure one against the other.

## Packages

| Package | What it does | Status |
|---|---|---|
| [`@decisis/core`](packages/core) | The decider interface, two adapters, validation, policy, overrides | **0.1.0** |
| [`@decisis/router`](packages/router) | A strong model plans, a fast model routes each task to a model tier, tasks run through the Claude Code CLI | **0.1.0** |
| [`@decisis/shadow`](packages/shadow) | Watch a system that already decides, record what the model *would* have decided, report the disagreements | **0.1.0** |
| [`@decisis/mcp`](packages/mcp) | MCP server: `classify`, `decide` and `route_model` as tools for any agent | **0.1.0** |

## For agents

Install the plugin in Claude Code (it carries the MCP server, three commands and a skill):

```
/plugin marketplace add ammar-genai/decisis
/plugin install decisis
cd ~/.claude/plugins/marketplaces/decisis && npm install   # once, until the packages are on npm
```

Then `/route <task>`, `/classify <thing>`, `/triage <output>`. Any other MCP client can run the server directly:

```json
{ "mcpServers": { "decisis": { "command": "node", "args": ["<clone>/packages/mcp/src/server.ts"],
  "env": { "OPENROUTER_API_KEY": "..." } } } }
```

Three tools: **`classify`** (one option from a named set, with an optional safety ladder), **`decide`** (several typed questions at once), **`route_model`** (the cheapest model tier that will do a task well, raised for risk or ambiguity). A failure comes back as a tool error with its reason, never as a crashed server.

## Measured

Same question, same state, one interface, two deciders — "split the orders table without downtime":

| Decider | Answer | Risk | Latency | Cost |
|---|---|---|---|---|
| Jev 1.13 | **opus** | High | 498 ms | $0.000019 |
| Qwen 3 235B | sonnet | Medium | 3,182 ms | $0.000032 |

The decisions model was right, six times faster and cheaper.

The same 30-task routing set, three deciders, one policy (`packages/router/eval`, `--decider`):

| Decider | Acceptable, alone | Under-routed, alone | With policy floors | Latency p50 |
|---|---|---|---|---|
| Jev 1.13 (OpenRouter) | 29/30 | 1 | **30/30**, 0 under | **0.3 s** |
| Claude Code · Haiku (no key) | 22/30 | 8 | 28/30, 2 under | 12.9 s |
| Claude Code · Sonnet (no key) | **30/30** | 0 | 30/30, 0 under | 6.5 s |

Two things to take from that. The floors earn their keep: they turned Haiku's 8 under-routes into 2. And the two it could not rescue were both cases where Haiku, asked which model a task needed, confidently chose itself - a model is a poor judge of whether the work is beyond it, so if you route with the CLI, judge with a tier above the cheapest one you might pick.

Through the MCP server, live: a CI failure reading "connection reset talking to the artifact registry" classified as `infra` in 300 ms for $0.000015; "add a /health endpoint with a test" routed to `sonnet` in 374 ms. On a 30-task labelled routing set (in `@decisis/router`), Jev plus the floor policy scored 90/90 acceptable with **zero under-routing**, at 49% of the cost of sending everything to the strongest model. Labels are hand-written; re-run them yourself with the packaged evaluation sets.

## No API key? Use the CLI you already have

```ts
import { claudeCodeDecider } from '@decisis/core';
const decide = claudeCodeDecider({ model: 'sonnet' });   // runs `claude -p --json-schema ...`
```

It costs no money, only your plan's usage window (each call carries Claude Code's own prompt overhead), and it takes seconds rather than milliseconds. For the MCP server: `DECISIS_DECIDER=claude DECISIS_MODEL=sonnet`.

## When not to use this

If you need free text, tool use, code, or open-ended reasoning, use a normal model. This is for the points where software has to *choose*.

## Development

```sh
npm install
npm test        # every adapter takes an injectable fetch: the tests never touch the network
npm run typecheck
```

Node 22+. No build step: the packages ship TypeScript that Node runs directly.

MIT licensed.
