import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTaskPrompt, attemptOutcome, nextTier, runPlan, TASK_RESULT_SCHEMA } from '../src/run.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { counterfactualUsd, familyOf } from '../src/cost.mjs';

const t = (id, tier, deps = []) => ({ id, title: `task ${id}`, description: 'd', files: [], depends_on: deps, acceptance: 'a', route: tier ? { tier } : undefined });
const res = (status, over = {}) => ({ ok: true, structured: { status, summary: `${status} summary`, files_changed: ['f'], tests_run: true, tests_passed: status === 'done', notes: `${status} notes` }, costUsd: 0.1, model: 'claude-sonnet-5', numTurns: 2, durationMs: 5, permissionDenials: 0, ...over });

test('task prompt includes dependency results, files and acceptance', () => {
  const p = buildTaskPrompt({ ...t('t2', 'haiku', ['t1']), files: ['x.ts'] }, { summary: 'proj' }, [{ id: 't1', title: 'first', summary: 'did it' }]);
  assert.match(p, /Project: proj/);
  assert.match(p, /- t1 first: did it/);
  assert.match(p, /Likely files: x.ts/);
  assert.match(p, /Do not commit or push/);
  const bare = buildTaskPrompt({ id: 'z', title: 'z', description: 'd' }, {});
  assert.match(bare, /\(no summary\)/);
  assert.match(bare, /not specified/);
  assert.match(bare, /the task is complete/);
  assert.deepEqual(TASK_RESULT_SCHEMA.properties.status.enum, ['done', 'blocked', 'failed']);
});

test('attemptOutcome: errors, missing output, failed tests, blocked, done', () => {
  assert.deepEqual(attemptOutcome({ ok: false, subtype: 'error_max_turns' }), { status: 'failed', reason: 'claude error_max_turns' });
  assert.deepEqual(attemptOutcome({ ok: false }), { status: 'failed', reason: 'claude error' });
  assert.deepEqual(attemptOutcome({ ok: true, structured: null }), { status: 'failed', reason: 'no structured result' });
  assert.deepEqual(attemptOutcome({ ok: true, structured: { status: 'weird' } }), { status: 'failed', reason: 'no structured result' });
  assert.equal(attemptOutcome(res('done', { structured: { status: 'done', tests_run: true, tests_passed: false } })).reason, 'reported done but tests failed');
  assert.deepEqual(attemptOutcome(res('done')), { status: 'done', reason: null });
  assert.deepEqual(attemptOutcome(res('blocked')), { status: 'blocked', reason: 'blocked notes' });
  assert.equal(attemptOutcome({ ok: true, structured: { status: 'failed', summary: 's' } }).reason, 's');
});

test('nextTier and cost counterfactual', () => {
  assert.equal(nextTier('haiku', DEFAULT_CONFIG.tiers), 'sonnet');
  assert.equal(nextTier('opus', DEFAULT_CONFIG.tiers), null);
  assert.equal(familyOf('claude-haiku-4-5'), 'haiku');
  assert.equal(familyOf(undefined), null);
  assert.equal(counterfactualUsd(0.1, 'claude-haiku-4-5'), 0.5);
  assert.equal(counterfactualUsd(0.1, 'mystery'), null);
  assert.equal(counterfactualUsd(0.1, 'haiku', 'gpt'), null);
});

test('runPlan runs in dependency order, escalates on failure, records every attempt', async () => {
  const routed = { summary: 's', tasks: [t('t2', 'haiku', ['t1']), t('t1', 'sonnet')] };
  const calls = [];
  const script = { t1: [res('done')], t2: [res('failed'), res('done', { model: 'claude-opus-5' })] };
  const fake = async (prompt, opts) => {
    const id = prompt.match(/YOUR TASK \((\w+)\)/)[1];
    calls.push([id, opts.model]);
    return script[id].shift();
  };
  const events = [];
  const ledger = [];
  const r = await runPlan({ routed, projectDir: '/p', config: DEFAULT_CONFIG, runId: 'R', runClaudeImpl: fake, onEvent: (e) => events.push(e.type), record: (e) => ledger.push(e) });
  assert.deepEqual(calls, [['t1', 'sonnet'], ['t2', 'haiku'], ['t2', 'sonnet']]);
  assert.equal(r.t2.status, 'done');
  assert.equal(r.t2.tier, 'sonnet');
  assert.equal(r.t2.attempts, 2);
  assert.ok(Math.abs(r.t2.costUsd - 0.2) < 1e-9);
  assert.equal(ledger.length, 3);
  assert.equal(ledger[1].status, 'failed');
  assert.equal(ledger[2].topModelCostUsd, 0.1);
  assert.ok(events.includes('escalate'));
});

test('runPlan stops at the top tier, does not escalate blocked tasks, and skips dependents', async () => {
  const routed = { tasks: [t('a', 'opus'), t('b', 'haiku'), t('c', 'haiku', ['a']), t('d', null, ['b'])] };
  const fake = async (prompt, opts) => (prompt.includes('(a)') ? res('failed', { model: null }) : prompt.includes('(b)') ? res('blocked') : res('done'));
  const events = [];
  const r = await runPlan({ routed, projectDir: '.', config: DEFAULT_CONFIG, runId: 'R', runClaudeImpl: fake, onEvent: (e) => events.push(e) });
  assert.equal(r.a.status, 'failed');
  assert.equal(r.a.attempts, 1); // already at the top tier: nothing to escalate to
  assert.equal(r.b.status, 'blocked');
  assert.equal(r.b.attempts, 1);
  assert.equal(r.c.status, 'skipped');
  assert.match(r.d.reason, /waiting on b/);
  assert.equal(events.filter((e) => e.type === 'escalate').length, 0);
});

test('runPlan treats a thrown runner error as a failed attempt', async () => {
  const r = await runPlan({ routed: { tasks: [t('a', 'opus')] }, projectDir: '.', config: DEFAULT_CONFIG, runId: 'R', runClaudeImpl: async () => { throw new Error('claude timed out'); } });
  assert.equal(r.a.status, 'failed');
  assert.equal(r.a.reason, 'claude claude timed out');
  assert.equal(r.a.costUsd, 0);
});

test('runPlan dry run, --only filtering and prior results', async () => {
  const routed = { tasks: [t('a', 'sonnet'), t('b', null, ['a']), t('c', 'haiku')] };
  const dry = await runPlan({ routed, projectDir: '.', config: DEFAULT_CONFIG, runId: 'R', dryRun: true, runClaudeImpl: async () => assert.fail('should not run') });
  assert.equal(dry.b.tier, 'opus'); // unrouted task defaults to the top tier
  assert.equal(dry.a.summary, '(dry run)');
  const called = [];
  const only = await runPlan({ routed, projectDir: '.', config: DEFAULT_CONFIG, runId: 'R', only: ['b'], prior: { a: { id: 'a', status: 'done', summary: 'earlier' } }, runClaudeImpl: async (p) => (called.push(p), res('done')) });
  assert.equal(called.length, 1);
  assert.match(called[0], /- a undefined: earlier|earlier/);
  assert.equal(only.b.status, 'done');
  assert.equal(only.c, undefined);
});

import { gitChangedFiles, outOfScope } from '../src/run.mjs';

test('gitChangedFiles parses porcelain output, handles renames, hides .jev-router, and returns null outside git', () => {
  const fake = () => ' M src/a.js\n?? test/new.test.js\nR  old.js -> lib/new.js\n?? .jev-router/ledger.jsonl\n';
  assert.deepEqual(gitChangedFiles('/p', fake), ['src/a.js', 'test/new.test.js', 'lib/new.js']);
  assert.equal(gitChangedFiles('/p', () => { throw new Error('not a git repo'); }), null);
});

test('outOfScope flags only new changes outside the declared files or directories', () => {
  assert.deepEqual(outOfScope(['src/a.js', 'test/x.test.js', 'README.md'], ['README.md'], ['src/a.js', 'test']), []);
  assert.deepEqual(outOfScope(['src/a.js', 'test/legacy.test.js'], [], ['src/a.js']), ['test/legacy.test.js']);
  assert.deepEqual(outOfScope(null, [], ['x']), []);
  assert.deepEqual(outOfScope(['z'], null, []), []);
  assert.deepEqual(outOfScope(['z'], null, ['y/']), ['z']);
});

test('runPlan records out-of-scope edits per attempt and emits a drift event', async () => {
  const snapshots = [[], ['src/a.js', 'test/legacy.test.js']];
  const events = [];
  const ledger = [];
  const r = await runPlan({
    routed: { tasks: [{ ...t('a', 'haiku'), files: ['src/a.js'] }] }, projectDir: '.', config: DEFAULT_CONFIG, runId: 'R',
    runClaudeImpl: async () => res('done'), changedFilesImpl: () => snapshots.shift(),
    onEvent: (e) => events.push(e), record: (e) => ledger.push(e),
  });
  assert.deepEqual(r.a.outOfScope, ['test/legacy.test.js']);
  assert.deepEqual(ledger[0].outOfScope, ['test/legacy.test.js']);
  assert.deepEqual(events.find((e) => e.type === 'drift').files, ['test/legacy.test.js']);
  assert.match(buildTaskPrompt(t('a'), {}), /Do not edit existing tests to make them pass/);
});
