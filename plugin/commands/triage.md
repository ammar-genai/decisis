---
description: Decide whether something needs a human now, and why
argument-hint: <paste the output, log, or status to triage>
allowed-tools: mcp__decisis__decide
---

Use the `decide` tool from the decisis MCP server to triage this:

$ARGUMENTS

Ask three questions in one call: `state` (a choice: working, blocked, needs_decision, done, failed), `needs_human` (a noul), and `severity` (a score: Low, Medium, High). Then say plainly whether a human is needed now and what the evidence was.

Err towards raising it: a missed problem costs more than an unnecessary interruption.
