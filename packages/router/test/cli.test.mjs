import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run, formatRouted } from '../src/cli.mjs';
import { readLedger, planPath, routedPath, writeJson } from '../src/store.mjs';
import { tmp, answers } from './helpers.mjs';

const plannerResult = { ok: true, model: 'claude-opus-5', costUsd: 0.3, durationMs: 10, structured: { summary: 'a shop', tasks: [
  { id: 't1', title: 'Rename', description: 'rename x', files: ['a'], depends_on: [], acceptance: 'ok' },
  { id: 't2', title: 'Migrate', description: 'migrate db', files: ['b'], depends_on: ['t1'], acceptance: 'ok' },
] } };
const jev = async (state) => ({ answers: state.task.title === 'Migrate' ? answers({ tier: 'opus', risk: 2, complexity: 3 }) : answers({ tier: 'haiku', conf: 0.99, complexity: 0 }), latencyMs: 100, usage: { cost: 0.00002 } });
const done = (s) => ({ ok: true, costUsd: 0.05, model: 'claude-haiku-4-5', structured: { status: 'done', summary: s, files_changed: [], tests_run: false, tests_passed: null } });

test('usage, bad flags and unknown commands', async () => {
  assert.equal((await run([])).code, 2);
  assert.equal((await run(['--help'])).code, 0);
  assert.match((await run(['plan', '--nope'])).out, /error: .*nope/);
  const u = await run(['frob', '--project', tmp()]);
  assert.match(u.out, /unknown command "frob"[\s\S]*Usage/);
});

test('full flow: plan -> route -> dry run -> run -> re-run skips done -> report', async () => {
  const d = tmp();
  const logs = [];
  const log = (l) => logs.push(l);
  assert.match((await run(['plan', '--project', d], { deps: { runClaude: async () => plannerResult } })).out, /plan needs a goal/);
  const p = await run(['plan', 'rename', 'and', 'migrate', '--project', d], { deps: { runClaude: async () => plannerResult }, log });
  assert.equal(p.code, 0);
  assert.match(p.out, /plan: 2 tasks {2}\(planner claude-opus-5, \$0\.3000\)/);
  assert.match(p.out, /t2 {4}Migrate <- t1/);

  const r = await run(['route', '--project', d], { deps: { loadKey: () => 'k', decide: jev } });
  assert.match(r.out, /t1 {4}haiku {3}Rename/);
  assert.match(r.out, /t2 {4}opus/);
  assert.match(r.out, /mix: haiku=1 opus=1/);

  const dry = await run(['run', '--dry-run', '--project', d], { log });
  assert.match(dry.out, /^dry run - nothing executed/);
  assert.ok(logs.some((l) => /t1 would run on haiku/.test(l)));
  assert.deepEqual(readLedger(d), []);

  const models = [];
  const real = await run(['run', '--project', d], { deps: { runClaude: async (prompt, opts) => (models.push(opts.model), done(`did ${opts.model}`)) }, log });
  assert.deepEqual(models, ['haiku', 'opus']);
  assert.match(real.out, /done {5}t2 {4}opus/);
  assert.ok(logs.some((l) => /t1 haiku \(attempt 1\): Rename/.test(l)));
  assert.ok(logs.some((l) => /-> done \$0\.0500/.test(l)));

  const again = [];
  await run(['run', '--project', d], { deps: { runClaude: async (p, o) => (again.push(o.model), done('x')) }, log });
  assert.ok(logs.some((l) => /t1 already done in an earlier run/.test(l)));
  assert.deepEqual(again, []); // both done in the ledger: nothing re-runs

  const rep = await run(['report', '--project', d]);
  assert.match(rep.out, /tasks: 2 {2}done=2/);
  assert.equal(JSON.parse((await run(['report', '--json', '--project', d])).out).attempts, 2);
});

test('run logs escalations and skips, and --only picks tasks', async () => {
  const d = tmp();
  writeJson(routedPath(d), { summary: 's', tasks: [
    { id: 'a', title: 'A', description: 'd', files: [], depends_on: [], route: { tier: 'haiku' } },
    { id: 'b', title: 'B', description: 'd', files: [], depends_on: ['a'], route: { tier: 'haiku' } },
    { id: 'c', title: 'C', description: 'd', files: [], depends_on: [], route: { tier: 'haiku' } },
  ] });
  const logs = [];
  const fail = { ok: true, costUsd: 0.01, model: 'claude-haiku-4-5', structured: { status: 'failed', summary: 'nope', files_changed: [], tests_run: false, tests_passed: null, notes: 'broke' } };
  const out = await run(['run', '--only', 'a, b', '--project', d], { deps: { runClaude: async () => fail }, log: (l) => logs.push(l) });
  // drift is reported in the log, the run table and the report
  writeJson(routedPath(d), { summary: 's', tasks: [{ id: 'c', title: 'C', description: 'd', files: ['src/c.js'], depends_on: [], route: { tier: 'haiku' } }] });
  const { execFileSync } = await import('node:child_process');
  execFileSync('git', ['init', '-q'], { cwd: d });
  const touch = async () => { writeFileSync(join(d, 'stray.txt'), 'x'); return { ok: true, costUsd: 0.01, model: 'claude-haiku-4-5', structured: { status: 'done', summary: 'ok', files_changed: [], tests_run: false, tests_passed: null } }; };
  const drifted = await run(['run', '--project', d], { deps: { runClaude: touch }, log: (l) => logs.push(l) });
  assert.match(drifted.out, /\[REVIEW: out of scope stray.txt\]/);
  assert.ok(logs.some((l) => /needs review: c changed files outside its scope: stray.txt/.test(l)));
  assert.match((await run(['report', '--project', d])).out, /REVIEW: out of scope stray.txt/);
  assert.ok(logs.some((l) => /escalating haiku -> sonnet/.test(l)));
  assert.ok(logs.some((l) => /b skipped: waiting on a/.test(l)));
  assert.match(out.out, /failed {3}a/);
  assert.doesNotMatch(out.out, / c /);
});

test('classify routes a one-off task; missing key and missing files are clear errors', async () => {
  const d = tmp();
  const c = await run(['classify', 'Migrate', '--project', d], { deps: { loadKey: () => 'k', decide: async () => ({ answers: answers({ tier: 'sonnet', risk: 2 }) }) } });
  assert.match(c.out, /^opus\n {2}proposed sonnet/);
  assert.match(c.out, /risk High/);
  const fb = await run(['classify', 'x', '--project', d], { deps: { loadKey: () => 'k', decide: async () => { throw new Error('down'); } } });
  assert.equal(fb.out, 'opus\n  jev unavailable (down); defaulting to opus');
  assert.match((await run(['classify', '--project', d], { deps: { loadKey: () => 'k' } })).out, /classify needs a task/);
  assert.match((await run(['classify', 'x', '--project', d], { deps: { loadKey: () => null } })).out, /no OPENROUTER_API_KEY/);
  assert.match((await run(['route', '--project', d], { deps: { loadKey: () => 'k' } })).out, /no plan yet/);
  assert.match((await run(['run', '--project', d])).out, /no routed plan yet/);
  writeFileSync(join(d, 'jev-router.config.json'), JSON.stringify({ tiers: ['opus'] }));
  assert.match((await run(['report', '--project', d])).out, /at least two/);
});

test('formatRouted shows fallback routes without scores', () => {
  const text = formatRouted({ tasks: [{ id: 'x', title: 'X', route: { tier: 'opus', reasons: ['jev unavailable'] } }] });
  assert.match(text, /^1 tasks/);
  assert.match(text, /jev unavailable$/m);
});
