---
name: typed-decisions
description: Use when a workflow needs a decision rather than prose - routing, triage, classification, screening, scoring - or when the user asks about decisis, typed decisions, Jev, or making an agent's own choices cheap, fast and auditable.
---

# Typed decisions

A decision point is anywhere software has to choose: which model runs a task, whether a failure needs a human, which bucket a document belongs in. Asking a large model for prose and parsing it back is slow, costly and different every time. Ask a typed question instead.

## The three shapes

| Shape | Answer | Use for |
|---|---|---|
| `noul` | a probability 0-1 | "does this need a human now?" |
| `choice` | one option from a named set | "which tier, bucket, or route?" |
| `score` | a level on an ordered list | "how risky?", "how severe?" |

Each question carries its own instructions and the meaning of every option, so a recorded decision explains itself later.

## The pattern

1. **Ask** the typed questions (the `classify`, `decide` and `route_model` tools).
2. **Apply policy in code, not in the prompt.** Floors, thresholds and fallbacks belong in ordinary code where they can be read, tested and changed. A policy should only ever move a decision towards the *safer* end of a ladder.
3. **Resolve uncertainty towards safety.** When confidence is below the floor, take the safer of the model's two most likely options - not a blind step up.
4. **Let a human overrule.** Store the machine answer and the human's override separately, and recompute the outcome from the final answer.
5. **Fail safe.** If the model is unreachable, take the cautious branch and record that you did.

## What this is not for

Free text, tool use, code, or open-ended reasoning. Use a normal model for those. This is for the moment of choosing.

## Measuring it

Write down the answers you would accept for twenty or thirty real cases, then run them. Two numbers matter: how often the decision is acceptable, and how often it lands *below* what the case needed. The second is the expensive error; the policy floors exist to drive it to zero.
