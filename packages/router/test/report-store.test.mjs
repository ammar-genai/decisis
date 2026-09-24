import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { latestByTask, priorDone, summarize, formatSummary } from '../src/report.mjs';
import { writeJson, readJson, appendLedger, readLedger, planPath } from '../src/store.mjs';
import { tmp } from './helpers.mjs';

const e = (task, attempt, tier, status, cost, top = cost * 2, reason = null) => ({ task, title: `T ${task}`, attempt, tier, status, costUsd: cost, topModelCostUsd: top, summary: `${task} ${status}`, reason });
const tiers = ['haiku', 'sonnet', 'opus'];

test('latestByTask and priorDone keep the newest outcome per task', () => {
  const ledger = [e('a', 1, 'haiku', 'failed', 0.1), e('a', 2, 'sonnet', 'done', 0.2), e('b', 1, 'haiku', 'blocked', 0.05)];
  assert.equal(latestByTask(ledger).a.status, 'done');
  assert.deepEqual(priorDone(ledger), { a: { id: 'a', title: 'T a', status: 'done', summary: 'a done', tier: 'sonnet', rev: null } });
});

test('completions belong to a plan, so a later plan reusing a task id is not skipped', () => {
  // The ledger spans every plan ever run in this project, and planners reuse ids like "t1".
  const ledger = [
    { ...e('t1', 1, 'haiku', 'done', 0.1), planId: 'oldplan', rev: 'r1' },
    { ...e('t1', 1, 'sonnet', 'done', 0.2), planId: 'newplan', rev: 'r2' },
  ];
  assert.deepEqual(Object.keys(priorDone(ledger, 'oldplan')), ['t1']);
  assert.equal(priorDone(ledger, 'oldplan').t1.rev, 'r1');
  assert.deepEqual(priorDone(ledger, 'thirdplan'), {}, 'an unrelated plan starts clean');
  // Entries written before plans had ids are ignored rather than trusted.
  assert.deepEqual(priorDone([e('t1', 1, 'haiku', 'done', 0.1)], 'anyplan'), {});
  // Without a planId the old behaviour is preserved for callers that pass nothing.
  assert.deepEqual(Object.keys(priorDone(ledger)), ['t1']);
});

test('summarize totals cost by tier, escalations and the top-model counterfactual', () => {
  const s = summarize([e('a', 1, 'haiku', 'failed', 0.1, 0.5), e('a', 2, 'sonnet', 'done', 0.2, 0.5), e('b', 1, 'fable', 'blocked', 1, 0.5, 'needs a call')], tiers);
  assert.equal(s.attempts, 3);
  assert.equal(s.tasks, 2);
  assert.deepEqual(s.statuses, { done: 1, blocked: 1 });
  assert.equal(s.escalations, 1);
  assert.ok(Math.abs(s.costUsd - 1.3) < 1e-9);
  assert.equal(s.topModelCostUsd, 1.5);
  assert.equal(s.byTier.fable.attempts, 1);
  const text = formatSummary(s, tiers);
  assert.match(text, /saved ≈ 13%/);
  assert.match(text, /blocked  b/);
  assert.match(text, /\(needs a call\)/);
  const unknown = summarize([e('c', 1, 'haiku', 'done', 0.1, null)], tiers);
  assert.equal(unknown.topModelCostUsd, null);
  assert.match(formatSummary(unknown, tiers), /\(rough\): n\/a/);
  assert.match(formatSummary(summarize([], tiers), tiers), /tasks: 0/);
});

test('store writes, reads and appends under .jev-router', () => {
  const d = tmp();
  assert.throws(() => readJson(planPath(d), 'plan'), /no plan yet/);
  writeJson(planPath(d), { x: 1 });
  assert.deepEqual(readJson(planPath(d), 'plan'), { x: 1 });
  assert.deepEqual(readLedger(d), []);
  appendLedger(d, { task: 'a' });
  appendLedger(d, { task: 'b' });
  assert.deepEqual(readLedger(d).map((x) => x.task), ['a', 'b']);
  assert.ok(planPath(d).endsWith(join('.jev-router', 'plan.json')));
});
