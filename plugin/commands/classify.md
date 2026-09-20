---
description: Classify something into one of several options, with confidence
argument-hint: <what to classify>
allowed-tools: mcp__decisis__classify
---

Classify the following with the `classify` tool from the decisis MCP server:

$ARGUMENTS

Work out sensible option names and a one-line meaning for each from the request, then pass them as `options`. If the options have a natural safe-to-risky order, also pass them as `ladder` so a low-confidence answer resolves towards the safer end.

Report the answer, its confidence, and any reason it was raised. Typed answers only: do not add an interpretation the tool did not give.
