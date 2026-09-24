# @decisis/core

**Typed decisions, deterministic policy, human override.** A model proposes; rules you can read decide; a person can always overrule. Built for the decision points inside software — routing, triage, classification, screening — where a fast, cheap, auditable answer beats a paragraph of prose.

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
- **Human override.** `withOverrides` merges a person's corrections over the machine's answers and reports which ones they changed. Feed that result back through the same policy and a review changes the outcome instead of arguing with it. Re-running the policy and storing the audit trail are the caller's job: this library keeps the decision honest, it is not a database.
- **Model-agnostic.** TypeSafe Jev through OpenRouter, or any chat model through structured outputs. Same questions, same policy, so you can measure one against the other.

## Exports

`jevDecider` · `llmDecider` · `claudeCodeDecider` · `resolveChoice` · `applyFloors` · `saferOfTopTwo` · `withOverrides` · `decideOrFallback` · `validateAnswers` · `choiceOf` / `noulOf` / `scoreOf` / `levelOf` · `loadKey`

## Part of decisis

This is the core library. The [repository](https://github.com/ammar-genai/decisis) also holds `@decisis/router` (a strong model plans, a fast model routes each task to a model tier), `@decisis/shadow` (record what a model *would* have decided about a system that already decides) and `@decisis/mcp` (the same decisions as MCP tools), plus a Claude Code plugin.

## Measured

Same question, same state, one interface, two deciders — "split the orders table without downtime":

| Decider | Answer | Risk | Latency | Cost |
|---|---|---|---|---|
| Jev 1.13 | **opus** | High | 498 ms | $0.000019 |
| Qwen 3 235B | sonnet | Medium | 3,182 ms | $0.000032 |

The decisions model was right, six times faster and cheaper. On a 30-task labelled routing set (in `@decisis/router`), Jev plus the floor policy scored 90/90 acceptable with **zero under-routing**, and would have spent 49% of an all-opus run in model price units.

**What that number is, and is not.** The evaluation scores agreement with hand-written labels and prices the chosen tiers with fixed per-tier weights. It does not execute the tasks, so it does not measure whether the cheaper tier actually finished the work, how often a task needed a retry, or the real dollar total. Read it as a routing-agreement result. The labels are mine; re-run them yourself, or relabel them, with the packaged evaluation set.

## When not to use this

If you need free text, tool use, code, or open-ended reasoning, use a normal model. This is for the points where software has to *choose*.

## Development

```sh
npm install
npm test        # every adapter takes an injectable fetch: the tests never touch the network
npm run typecheck
```

Node 22.18 or newer, which is where Node began running TypeScript without a flag. No build step: the packages ship TypeScript that Node runs directly.

MIT licensed.
