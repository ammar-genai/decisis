# jev-router: a top model plans, Jev picks the model for each task

For big projects, one strong model (Opus by default) plans the work. Then **TypeSafe Jev**, a fast typed-decision model reached through OpenRouter, decides for each task whether **Haiku, Sonnet or Opus** should do it. Tasks run headless through the **Claude Code CLI** (`claude -p --model <tier>`) on your own plan, with no Anthropic API key needed. A failed task escalates one tier and retries.

```
goal ──▶ plan (opus, read-only) ──▶ route (jev, ~0.3 s, ~$0.00004/task) ──▶ run (claude -p per task) ──▶ report
                                         │  tier + complexity + risk + ambiguity
                                         └▶ safety floors (only raise, never lower)
```

## Quick start

Needs Node ≥ 22, the `claude` CLI logged in, and `OPENROUTER_API_KEY` (env, `jev-router/.env`, or `../jev-test/.env`).

```sh
cd your-project
/path/to/jev-router/bin/jev-router.mjs plan "Add multi-currency pricing and fix the test script"
/path/to/jev-router/bin/jev-router.mjs route          # review .jev-router/routed.json; edit any route.tier
/path/to/jev-router/bin/jev-router.mjs run --dry-run  # show what would run where
/path/to/jev-router/bin/jev-router.mjs run            # execute; re-run later to resume
/path/to/jev-router/bin/jev-router.mjs report
/path/to/jev-router/bin/jev-router.mjs classify "Split the orders table without downtime"   # one-off routing
```

State is written to `<project>/.jev-router/`: `plan.json`, `routed.json`, and `ledger.jsonl` (one line per attempt). Add `.jev-router/` to your `.gitignore`. Nothing is committed or pushed. You review the diff.

## How it decides

**1. Plan.** `claude -p --model opus --json-schema <plan schema>` runs in the project with only `Read/Glob/Grep` allowed. It returns `{summary, tasks: [{id, title, description, files, depends_on, acceptance}]}`. The plan is checked for duplicate ids, unknown dependencies and cycles.

**2. Route.** Jev answers four typed questions per task (state: project summary + task):

| Question | Type | Meaning |
|---|---|---|
| `tier` | choice | haiku (mechanical, local, fully specified) · sonnet (normal feature/bug work) · opus (design, cross-cutting, security, migrations, unknown-cause debugging). It picks the **cheapest** tier that will reliably do the job. |
| `complexity` | score | Trivial · Routine · Moderate · Hard · Very hard |
| `risk` | score | Low · Medium · High: how costly or hard to spot a subtle mistake would be |
| `ambiguity` | noul | P(the task needs design or product decisions it doesn't spell out) |

Then a **policy that only raises the tier** is applied. Under-routing is the costly error; over-routing just costs money.
- If confidence is below 0.6, the task gets the **stronger of Jev's two most likely tiers**. For example, "sonnet 0.72 / haiku 0.28" gives sonnet, not opus.
- Risk High means at least opus; risk Medium means at least sonnet.
- Complexity "Very hard" means at least opus.
- Ambiguity above 0.6 means at least sonnet.
- If Jev is unavailable, the task goes to **opus** (never silently cheap).

Every route records its reasons, e.g. `jev picked haiku (confidence 0.35); confidence 0.35 < 0.6: stronger of haiku/sonnet`.

**3. Run.** Tasks run in dependency order. Each attempt is `claude -p --model <tier> --json-schema <result schema> --permission-mode acceptEdits --allowedTools … --max-budget-usd 2`, and the task reports `{status: done|blocked|failed, summary, files_changed, tests_run, tests_passed}`.
- **failed**, or "done" with failing tests, escalates one tier (up to `maxAttempts`).
- **blocked** (needs a human decision) is not escalated.
- Dependents of a task that isn't done are skipped. A later `run` resumes, and done tasks are never re-run.
- **Scope check:** git changes made during an attempt that fall outside the task's `files` are flagged `[REVIEW: out of scope …]` in the run output, the ledger and the report. The task prompt also forbids editing existing tests to make them pass. Both were added after the live demo, where Haiku "fixed" a deliberately contradictory test while it was only meant to fix the npm test script.

**4. Report.** Shows cost by tier, escalations, and a rough **"same tokens, all on opus"** counterfactual. Opus, Sonnet and Haiku all price output at 5× input, so the counterfactual is actual cost × (opus input price ÷ model input price). It's an estimate: a different model wouldn't use identical tokens.

## Config: `<project>/jev-router.config.json`

Everything in `src/config.mjs` `DEFAULT_CONFIG` can be overridden (objects deep-merge; arrays replace):

```json
{
  "tiers": ["haiku", "sonnet", "opus"],
  "planner": { "model": "opus", "maxBudgetUsd": 3 },
  "policy": { "confidenceFloor": 0.6, "riskFloor": { "High": "opus", "Medium": "sonnet" }, "ambiguityThreshold": 0.6 },
  "run": { "permissionMode": "acceptEdits", "maxAttempts": 2, "maxBudgetUsdPerAttempt": 2,
           "allowedTools": ["Read", "Glob", "Grep", "Edit", "Write", "Bash(npm test*)", "Bash(npm run *)"] }
}
```

- To drop a floor, set it to `null` (for example `"riskFloor": {"Medium": null}`). An empty `{}` merges into the defaults and changes nothing.
- To plan with Fable, set `"planner": {"model": "fable"}`. That needs usage credits on your plan.
- Tier names are passed straight to `claude --model`, so full model IDs work too.

## Evaluation (2026-09-19, `typesafe/jev-1.13-20260917`)

`eval/tasks.mjs` has 30 hand-labelled tasks for an imaginary e-commerce monorepo: 10 mechanical, 12 normal and 8 hard. Each has an ideal tier and a set of acceptable tiers. Run it with `npm run eval -- --runs 3` (costs about $0.003).

| 3 runs × 30 tasks | acceptable | ideal | **under-routed** | over-routed |
|---|---|---|---|---|
| Jev pick alone | 87/90 | 84/90 | 3 | 0 |
| **Jev + policy** | **90/90** | 85/90 | **0** | 0 |

- **Cost:** in model price units, 231 against 450 for all-Opus (**49% cheaper**), and 222 for my ideal labels.
- **Speed:** Jev's p50 latency was about 300 ms.
- **Caveat:** I wrote both the tasks and their labels. Treat this as evidence that the approach works, not as a measured production accuracy.

**Live demo** (`../demo-jevlab`, a copy of the jevlab sandbox, 2026-09-19). Goal: multi-currency `formatPrice`, fix the npm test script on Node 26, and reword the README.
- **Plan:** Opus returned 3 tasks in 30 s for $0.44, with a sensible dependency (docs after code).
- **Route:** Jev picked sonnet (currency; confidence 0.38, and its top two were sonnet/haiku, so sonnet stood), haiku (test script) and haiku (README).
- **Run:** 3/3 done, no escalations, 17 min in total (mostly the sandbox's deliberate 4-minute integration test). Cost **$1.13** against about $4.52 for the same tokens on Opus (**≈75% saved**), plus $0.44 for planning.
- **Finding:** the Haiku test-script task also "fixed" the sandbox's deliberately contradictory `test/legacy-tax.test.js` by changing the test, which was out of scope. That's why the task prompt now forbids editing tests to make them pass, and why the scope check exists. Replayed on this run, the check flags exactly `test/legacy-tax.test.js`. The edit was reverted in the demo repo.

## Tests

```sh
npm test        # 41 unit tests; claude and Jev are faked, so they run offline and are free
npm run coverage
```

## Layout

```
src/config.mjs   defaults + per-project config        src/plan.mjs    planner prompt/schema, plan validation, topo order
src/claude.mjs   headless `claude -p` runner          src/route.mjs   Jev questions + floor policy
src/run.mjs      execution, escalation, scope check   src/report.mjs  ledger summaries
src/cost.mjs     counterfactual pricing               src/store.mjs   .jev-router/ files
src/jev.mjs      OpenRouter Decisions client          src/key.mjs     key lookup
src/cli.mjs      commands                             eval/           labelled routing eval
```
