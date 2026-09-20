// Labelled wake-triage scenarios. `expect.action` is what a careful human supervisor would do;
// `expect.states` lists the acceptable crew_state answers. Panes imitate Claude Code / shell output.
// Only no-verb / stale-pane cases are here: terminal verbs never reach Jev (they always wake).
const BRIEF_LOGIN = 'Fix the flaky login test in src/auth (fails ~1 in 5 CI runs). Ship a PR.';
const BRIEF_DOCS = 'Scout: investigate why the docs site build takes 9 minutes and write data/<id>/report.md with the top 3 causes.';
const BRIEF_API = 'Add pagination (cursor-based) to GET /api/orders. Keep the response backward compatible. Ship a PR.';

export default [
  {
    id: 'working-tests-running',
    statusLine: 'working: setup complete, reproducing the flake',
    brief: BRIEF_LOGIN,
    pane: `⏺ Update(src/auth/mock.ts)
  ⎿  Updated src/auth/mock.ts with 4 additions and 1 removal
⏺ Now run the auth suite 20 times to confirm the race is gone.
⏺ Bash(for i in $(seq 20); do pnpm test --filter auth || exit 1; done)
  ⎿  ✓ src/auth/login.test.ts (12 tests) 1.8s
     ✓ src/auth/login.test.ts (12 tests) 1.7s
     ✓ src/auth/login.test.ts (12 tests) 1.9s
     … +9 lines
✶ Running… (2m 14s · esc to interrupt)`,
    expect: { action: 'absorb', states: ['working'] },
  },
  {
    id: 'working-editing-files',
    statusLine: '',
    brief: BRIEF_API,
    pane: `⏺ Read(src/api/orders.ts)
  ⎿  Read 212 lines
⏺ Read(src/db/orders-repo.ts)
  ⎿  Read 98 lines
⏺ I'll add a cursor param encoded as base64(created_at,id) and keep offset for old clients.
⏺ Update(src/db/orders-repo.ts)
  ⎿  Updated src/db/orders-repo.ts with 31 additions and 4 removals
⏺ Update(src/api/orders.ts)
  ⎿  Updated src/api/orders.ts with 18 additions
✻ Writing tests… (48s · esc to interrupt)`,
    expect: { action: 'absorb', states: ['working'] },
  },
  {
    id: 'working-long-install',
    statusLine: 'working: installing deps before profiling build',
    brief: BRIEF_DOCS,
    pane: `⏺ Bash(pnpm install --frozen-lockfile)
  ⎿  Lockfile is up to date, resolution step is skipped
     Progress: resolved 1340, reused 812, downloaded 214, added 1026
     Progress: resolved 1340, reused 812, downloaded 377, added 1189
✢ Running… (3m 02s · esc to interrupt)`,
    idleSeconds: 45,
    expect: { action: 'absorb', states: ['working'] },
  },
  {
    id: 'working-build-profile',
    statusLine: '',
    brief: BRIEF_DOCS,
    pane: `⏺ Bash(time pnpm --filter docs build --profile)
  ⎿  [webpack] compiling client  64% building 2210/3401 modules
     [webpack] compiling server  41% building 980/2402 modules
✳ Running… (5m 40s · esc to interrupt)`,
    idleSeconds: 90,
    expect: { action: 'absorb', states: ['working'] },
  },
  {
    id: 'waiting-ci-declared',
    statusLine: 'paused: waiting for CI run 8812 on fix/login-flake until 2026-09-18T15:00Z',
    brief: BRIEF_LOGIN,
    pane: `⏺ Bash(gh pr checks 57 --watch=false)
  ⎿  build     pending  https://github.com/acme/app/actions/runs/8812
     e2e       pending  https://github.com/acme/app/actions/runs/8812
⏺ CI is still running (usually ~25 min). I've appended a paused: line and will re-check when it finishes.
>`,
    idleSeconds: 600,
    expect: { action: 'absorb', states: ['waiting_external'] },
  },
  {
    id: 'looping-same-failure',
    statusLine: 'working: investigating flaky login test',
    brief: BRIEF_LOGIN,
    pane: `⏺ Bash(pnpm test --filter auth)
  ⎿  FAIL src/auth/login.test.ts > logs in with valid token
     Expected 200, received 401
⏺ Let me fix the token mock and re-run.
⏺ Update(src/auth/mock.ts)
  ⎿  Updated src/auth/mock.ts with 2 additions and 1 removal
⏺ Bash(pnpm test --filter auth)
  ⎿  FAIL src/auth/login.test.ts > logs in with valid token
     Expected 200, received 401
⏺ The mock change didn't help. Let me try updating the token mock again.
⏺ Update(src/auth/mock.ts)
  ⎿  Updated src/auth/mock.ts with 1 addition and 2 removals
⏺ Bash(pnpm test --filter auth)
  ⎿  FAIL src/auth/login.test.ts > logs in with valid token
     Expected 200, received 401
✻ Thinking…`,
    expect: { action: 'wake', states: ['stuck_or_looping'] },
  },
  {
    id: 'looping-edit-oscillation',
    statusLine: '',
    brief: BRIEF_API,
    pane: `⏺ Update(src/api/orders.ts)
  ⎿  Changed limit default from 50 to 100
⏺ Bash(pnpm typecheck)
  ⎿  error TS2345: Argument of type 'number | undefined' is not assignable to 'number'.
⏺ Update(src/api/orders.ts)
  ⎿  Changed limit default from 100 to 50
⏺ Bash(pnpm typecheck)
  ⎿  error TS2345: Argument of type 'number | undefined' is not assignable to 'number'.
⏺ Update(src/api/orders.ts)
  ⎿  Changed limit default from 50 to 100
⏺ Bash(pnpm typecheck)
  ⎿  error TS2345: Argument of type 'number | undefined' is not assignable to 'number'.`,
    expect: { action: 'wake', states: ['stuck_or_looping'] },
  },
  {
    id: 'permission-prompt',
    statusLine: 'working: applying migration',
    brief: BRIEF_API,
    pane: `⏺ Bash(pnpm prisma migrate deploy)

  Bash command
    pnpm prisma migrate deploy
    Apply pending migrations to the database

  Do you want to proceed?
  ❯ 1. Yes
    2. Yes, and don't ask again for pnpm prisma commands
    3. No, and tell Claude what to do differently (esc)`,
    idleSeconds: 420,
    expect: { action: 'wake', states: ['needs_decision', 'stuck_or_looping'] },
  },
  {
    id: 'question-in-prose',
    statusLine: '',
    brief: BRIEF_API,
    pane: `⏺ I found two ways to keep old clients working:
  (A) keep ?offset= forever and add ?cursor= alongside it (simple, but two code paths)
  (B) translate ?offset= into a cursor server-side and deprecate it (one path, small perf cost)
  Which would you prefer? I'll wait for your answer before continuing.

>`,
    idleSeconds: 300,
    expect: { action: 'wake', states: ['needs_decision'] },
  },
  {
    id: 'done-in-prose-no-verb',
    statusLine: 'working: pushing branch',
    brief: BRIEF_LOGIN,
    pane: `⏺ Bash(gh pr create --fill --base main)
  ⎿  https://github.com/acme/app/pull/57
⏺ All done! The race in the auth mock is fixed, 20/20 local runs pass, CI is green and PR #57 is open for review.

>`,
    idleSeconds: 240,
    expect: { action: 'wake', states: ['done'] },
  },
  {
    id: 'scout-report-written',
    statusLine: '',
    brief: BRIEF_DOCS,
    pane: `⏺ Write(data/fm-51/report.md)
  ⎿  Wrote 64 lines to data/fm-51/report.md
⏺ Report complete. Top causes: (1) image optimisation runs on every build, (2) no persistent webpack cache in CI, (3) 3 duplicate MDX passes. Details in the report.

>`,
    idleSeconds: 200,
    expect: { action: 'wake', states: ['done'] },
  },
  {
    id: 'disk-full-gave-up',
    statusLine: '',
    brief: BRIEF_DOCS,
    pane: `⏺ Bash(pnpm --filter docs build)
  ⎿  Error: ENOSPC: no space left on device, write '/tmp/webpack-cache/0.pack'
⏺ The machine is out of disk space, so I can't build or profile anything. I can't continue with this task.

>`,
    idleSeconds: 180,
    expect: { action: 'wake', states: ['failed', 'stuck_or_looping'] },
  },
  {
    id: 'agent-crashed-shell',
    statusLine: 'working: running e2e suite',
    brief: BRIEF_API,
    pane: `  ⎿  ✓ orders pagination returns next_cursor (412ms)
     ✓ orders pagination rejects bad cursor (97ms)

FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
claude exited with code 134
ammar@mac fm-63 %`,
    idleSeconds: 500,
    expect: { action: 'wake', states: ['failed'] },
  },
  {
    id: 'stopped-mid-task-silently',
    statusLine: 'working: rebased onto main',
    brief: BRIEF_API,
    pane: `⏺ Bash(git rebase origin/main)
  ⎿  Successfully rebased and updated refs/heads/feat/orders-cursor.
⏺ Rebase done. Next I'll update the OpenAPI spec and add the integration tests.

>`,
    idleSeconds: 900,
    expect: { action: 'wake', states: ['stuck_or_looping'] },
  },
  {
    id: 'context-exhausted',
    statusLine: '',
    brief: BRIEF_API,
    pane: `⏺ Read(src/api/orders.test.ts)
  ⎿  Read 1840 lines
  ⎿  Context low (2% remaining) · Run /compact to compact & continue

>`,
    idleSeconds: 400,
    expect: { action: 'wake', states: ['stuck_or_looping'] },
  },
  {
    id: 'working-after-nudge',
    statusLine: 'working: resolved k1, switching to option B',
    brief: BRIEF_API,
    pane: `> Go with option B (translate offset into a cursor server-side).
⏺ Got it — option B. Updating the handler to translate ?offset= into a cursor.
⏺ Update(src/api/orders.ts)
  ⎿  Updated src/api/orders.ts with 22 additions and 9 removals
✽ Running tests… (21s · esc to interrupt)`,
    expect: { action: 'absorb', states: ['working'] },
  },
];
