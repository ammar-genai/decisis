# @decisis/local

**Typed decisions from a model on your own machine.** No API key, no account, and no network after the first download. A small natural-language-inference model answers the same typed questions as every other decisis decider, so it drops into the same policy, the same MCP server and the same evaluation sets.

```js
import { localDecider } from '@decisis/local';

const decide = localDecider();
const { answers } = await decide(
  { task: { title: 'Split the orders table without downtime' } },
  { tier: { type: 'choice', instructions: 'Which model should do this?', criteria: { haiku: 'a tiny edit', sonnet: 'a normal task', opus: 'a hard problem' } } },
);
// { type: 'choice', choice: 'opus', confidence: 0.48, probabilities: { … } }
```

Or behind the hosted API's own shape, so an existing client needs one changed line:

```sh
npx decisis-local --port 8088
```

```js
const decide = jevDecider({ url: 'http://127.0.0.1:8088/decisions', key: 'unused' });
```

## Install

The model runtime is an **optional** peer dependency, because it is about 1.2 GB:

```sh
npm install @huggingface/transformers
```

The model itself (about 350 MB) downloads on the first decision and is cached. Everything after that is offline. Without the runtime installed, the decider throws a message telling you to install it.

## How it works

An NLI model scores whether a premise entails a hypothesis. The state is the premise, each option becomes a hypothesis, and a softmax over the entailment scores is the distribution. A `choice` is the winning option, a `noul` is a two-option choice read as one probability, and a `score` is the winning level's index.

That is the whole trick, and it explains both the speed and the limits.

## Measured

The router's 30-task labelled routing set, same questions and same policy as every other decider:

| Decider | Acceptable alone | Under-routed | With policy floors | Latency p50 | Cost |
|---|---|---|---|---|---|
| Jev 1.13 (hosted) | 29/30 | 1 | **30/30**, 0 under | **0.3 s** | $0.00002 |
| **local** (this package) | 23/30 | 2 | 22/30, 1 under | 0.27 s | **$0** |
| local, `nli-deberta-v3-small` | 13/30 | 14 | 18/30, 1 under | 0.14 s | $0 |
| Claude Code · Haiku | 22/30 | 8 | 28/30, 2 under | 12.9 s | subscription |

It is **deterministic**: two runs of the evaluation returned identical answers on all 30 tasks, which no sampled model does. Reproduce with `node eval/run-eval.mjs --decider local` in `@decisis/router`.

## Two things that decide whether this works for you

Both were found by measuring, and both are options on `localDecider`.

**Focus the premise.** An NLI model weighs the entire premise. Shared context repeated on every call - the project blurb, the stack, the CI setup - pulls every decision the same way and drowns out the part that differs. Focusing on the task alone took this from 13/30 to 23/30.

```js
localDecider({ focus: ['task'] })
```

**Rewrite the criteria as phrases.** Criteria are usually written as instructions to a large model: *"Mechanical, fully specified and local: renames, typo fixes, formatting…"*. An NLI model never reads the instructions. It needs a natural phrase that completes `This example is {}.`

```js
localDecider({ labels: { tier: { haiku: 'a mechanical, local change such as a rename or a typo fix', … } } })
```

`@decisis/router` keeps its own phrasings in `eval/local-labels.mjs` as a worked example.

## Options

| Option | Default | What it does |
|---|---|---|
| `model` | `MoritzLaurer/deberta-v3-base-zeroshot-v1.1-all-33` | Any zero-shot model on the Hugging Face hub with ONNX weights |
| `template` | `This example is {}.` | Hypothesis template; `{}` becomes the option text |
| `labels` | none | Per-question phrasings that replace the question's `criteria` |
| `focus` | none | Top-level state keys to judge on |
| `maxChars` | 2000 | Premise length cap |
| `dtype` | `q8` | Quantisation; `fp32` is slower and larger |
| `classifyImpl` | none | Your own classifier, for tests |

`SMALL_MODEL` is exported for the faster, less accurate option.

## When to use it, and when not

Use it when a decision must be free, private or offline, when you need determinism, or as a first-pass filter in front of a stronger decider.

Do not use it where a wrong answer is expensive. It is 23/30 against Jev's 30/30, and a model this size has no judgement to fall back on: it is comparing text, not reasoning about consequences. The policy floors matter more here than anywhere else in decisis, and they are what keep its under-routing at 1.

## Licence

MIT
