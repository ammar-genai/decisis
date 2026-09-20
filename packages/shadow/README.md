# jev-mate: Jev as firstmate's decision layer (prototype)

TypeSafe **Jev** (`typesafe/jev-1.13`, called through OpenRouter) makes two of firstmate's recurring decisions. Each call takes about 250 ms and costs about $0.00002.

1. **Wake triage.** A crewmate went quiet, or posted a status line with no terminal verb. Should the watcher **absorb** the wake, or **wake** the first mate (a full Claude turn)?
2. **Dispatch routing.** Which `config/crew-dispatch.json` rule fits a new task brief? This asks the same question as firstmate's `bin/fm-dispatch-resolve.sh`, but through OpenRouter instead of `api.typesafe.ai`.

This is a standalone prototype. It does **not** modify the `../firstmate` clone. See "Plugging into firstmate" below.

## Run it

Needs Node ≥ 22 and no npm dependencies. The key is read from the `OPENROUTER_API_KEY` env var, `jev-mate/.env` or `../jev-test/.env`.

```sh
# Triage one wake from files (pane from stdin with --pane-file -)
./bin/decisis-shadow.mjs triage --status "working: fixing flake" --pane-file pane.txt [--brief-file brief.md] [--idle-seconds 300] [--json]

# Triage a live firstmate task: reads state/<id>.status, data/<id>/brief.md, and bin/fm-peek.sh <id> 60
./bin/decisis-shadow.mjs triage --task <id> --fm-home ../firstmate

# Route a brief against dispatch rules (default rules path: $FM_HOME/config/crew-dispatch.json)
./bin/decisis-shadow.mjs route --brief-file brief.md --rules eval/sample-crew-dispatch.json

# Shadow a live firstmate (read-only sidecar), then summarise
./bin/decisis-shadow.mjs shadow --fm-home ../firstmate [--interval 3] [--log shadow.jsonl] [--herdr]
./bin/decisis-shadow.mjs shadow-report [--log shadow.jsonl] [--json]

npm test            # 57 unit tests, offline (fetch is faked)
npm run coverage    # 100% lines, ~97% branches on src/
npm run eval        # live labelled evaluation against Jev (costs ~$0.001); --runs N, --only triage|route, --verbose
```

Every command exits 0 unless the usage is wrong. The first output line is `action: absorb|wake` (triage) or `status: clear|ambiguous|escalate|error` (route), so a shell script can read it.

## How triage decides

1. **Deterministic first.** A terminal status verb (`done:`, `needs-decision:`, `blocked:`, `failed:`) always wakes, without calling Jev. This matches firstmate's `status_is_terminal_verb`.
2. **Otherwise ask Jev** about `{task.brief, last_status_line, pane_tail (last 60 lines / 6000 chars), pane_unchanged_seconds}`:
   - `crew_state` (choice): `working`, `waiting_external`, `stuck_or_looping`, `needs_decision`, `done` or `failed`
   - `needs_supervisor` (noul): does the supervisor need to act now?
   - `looping` (noul): is the crewmate repeating the same action or error?
3. **Policy** (`decideAction` in `src/triage.mjs`). **Absorb only if** `crew_state` is `working` or `waiting_external`, **and** its confidence is ≥ 0.7, **and** `needs_supervisor` ≤ 0.3, **and** `looping` ≤ 0.5. Anything else wakes the first mate, with every failing condition listed as the reason, plus a hint (nudge / answer / review / inspect).
4. **Fail safe.** An API error, timeout (5 s, one retry on 429/5xx/network) or malformed answer → `wake`. A missed wake is the only dangerous error, so every doubt becomes a wake.

Routing uses the same fixed `default` option text and 0.6 confidence floor as `fm-dispatch-resolve.sh`. `approval: "captain"` → `escalate`. Quota floors and spendPriority ranking are left to firstmate and not reimplemented here. A malformed rules file throws, since firstmate treats config errors as actionable. API trouble returns `status: error`, so firstmate decides as it does today.

## Evaluation (2026-09-18, `typesafe/jev-1.13-20260917`)

`eval/triage-cases.mjs` has 16 hand-written panes covering: working (tests, edits, install, build, after a nudge), a declared CI wait, two kinds of loop, a permission prompt, a question in prose, done-in-prose without a verb, a written scout report, a full disk, a crashed agent, a crewmate that stopped silently mid-task, and exhausted context. `eval/route-cases.mjs` has 9 briefs against `eval/sample-crew-dispatch.json` (firstmate's example rules plus a captain-approval rule).

| | 1 run | 3 runs |
|---|---|---|
| Triage action accuracy | 16/16 | 48/48 |
| Triage crew_state accuracy | 16/16 | 48/48 |
| **Missed wakes** (absorbed when it should wake) | **0** | **0** |
| Wakes saved (absorbable cases absorbed) | 6/6 | 18/18 |
| Routing rule accuracy | 9/9 | 27/27 |
| Latency (16 calls in parallel) | p50 426 ms | p50 264 ms, p95 1040 ms |
| Cost | $0.0006 for 16 triages | ≈ $0.00004 per triage, ≈ $0.00002 per route |

Notes:
- Its weakest call was "stopped mid-task silently": correct, but at confidence 0.51. The policy still wakes because the state isn't absorbable.
- A trailing `✻ Thinking…` spinner under three identical failures didn't fool it (looping 0.97).

**Caveat:** I wrote both the cases and their labels, so they are cleaner than real panes. Treat the 100% as "the approach works", not as a production accuracy figure. The real test is shadow mode on live crewmates (below).

## Shadow mode (`decisis-shadow shadow`)

This is a read-only sidecar, so firstmate needs no patch. It polls two files in the firstmate home every 3 s:

- `state/.wake-queue`: every wake delivered to the first mate. Each row is `epoch\tseq\tkind\tkey\tpayload`, as written by `fm_wake_append_locked` in `bin/fm-wake-lib.sh`. Rows stay until the first mate acknowledges them, so polling doesn't miss any.
- `state/.watch-triage.log`: wakes the watcher absorbed itself (`[ts] absorbed … : <window>`).

For each **crewmate** wake (kinds `signal` and `stale`; `check` and `heartbeat` are skipped), it triages the task straight away. It maps the wake to a task the same way firstmate does: a signal key `<id>.status` gives the id directly, and a stale window is looked up through the `window=`/`terminal=` lines in `state/<id>.meta`. It then appends one JSON line with Jev's verdict, the status line and the last 15 pane lines. Wakes already on disk when it starts are skipped.

With `--herdr`, each record also gets a **third judge**: herdr's native agent state for the task's pane. The pane id is the last `wN:pN` found in `state/<id>.meta`, looked up with `herdr agent get <pane>`, and the state is `working`, `blocked`, `idle`, `done`, `unknown`, `no-pane` or `error`. The report then adds how often herdr said `blocked` on a wake that firstmate absorbed.

A **stale wake after a terminal verb that was already delivered** (`done:`, `needs-decision:`, `blocked:`, `failed:`) doesn't wake automatically. Jev is asked whether the pane still shows the reported situation: if it does, the wake is absorbed as "nothing new"; if it has diverged, it wakes. Fresh signals with a terminal verb still always wake. This was added after the first live trial showed firstmate re-waking the first mate about finished crewmates.

`shadow-report` counts four things:
- **firstmate woke → Jev would absorb:** first-mate turns Jev could save. This is the value-add.
- **firstmate absorbed → Jev would wake:** cases where firstmate's own rules might have let a real problem pass.
- Jev's crew-state mix, latency and cost.
- Every disagreement, listed with its pane excerpt so a human can judge who was right.

## Plugging into firstmate (after shadow mode)

1. **Shadow mode first** (above). Collect a few days of real wakes and review the disagreements.
2. **Then gate.** Absorb only when both hold: Jev says `absorb` **and** the crewmate's pane hash changed recently or its agent is alive. Keep firstmate's existing re-surface cadence (`FM_STALE_ESCALATE_SECS`) as the backstop, so a wrong absorb costs at most one delay window.
3. **Routing.** `fm-dispatch-resolve.sh` already uses Jev but hard-codes `https://api.typesafe.ai/v1/systemone` and `TYPESAFE_API_KEY`. To use OpenRouter, change it to `https://openrouter.ai/api/alpha/decisions` with an OpenRouter key and `model: typesafe/jev-1.13`. The body and answer format are identical, as this prototype shows.

## Layout

```
src/jev.mjs      OpenRouter Decisions client: timeout, one retry, answer validation
src/triage.mjs   wake triage questions + absorb/wake policy
src/route.mjs    dispatch-rule routing (fm-dispatch-resolve question, via OpenRouter)
src/key.mjs      key lookup (env, .env files)
src/shadow.mjs   read-only shadow sidecar + report
src/cli.mjs      CLI logic; bin/decisis-shadow.mjs is the thin entry point
test/            node:test unit tests with a fake fetch
eval/            labelled cases, sample dispatch rules, live eval runner (results-*.json gitignored)
```

## Live trials (18–19 Sep 2026)

Two shadow trials ran over the `jevlab` sandbox with five real Claude crewmates. Full write-up: `../SETUP_NOTES.md` and the report at `../jev-takes-the-watch.html`.

| | firstmate on tmux | firstmate on herdr | Jev |
|---|---|---|---|
| Crewmate frozen at a permission prompt | silent about 60 min, then wakes with no cause | woken in about 3 min, cause attached | right action every time |
| Wake after `done:` was already delivered | wakes (4 of 33) | wakes (3 of 14) | absorbs 7 of 7 |
| Total Jev cost | $0.0063 (50 verdicts) | $0.0012 (14 verdicts) | 0 errors |

