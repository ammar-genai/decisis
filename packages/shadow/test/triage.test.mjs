import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusVerb, trimPane, buildTriageState, decideAction, triageWake, TRIAGE_QUESTIONS, CREW_STATES, HINTS, TERMINAL_VERBS } from '../src/triage.mjs';
import { fakeFetch, ok, triageAnswers } from './helpers.mjs';

test('statusVerb reads the leading verb like firstmate', () => {
  assert.equal(statusVerb('done: PR #57'), 'done');
  assert.equal(statusVerb('  Needs-Decision: A or B'), 'needs-decision');
  assert.equal(statusVerb('setup complete'), null);
  assert.equal(statusVerb(undefined), null);
});

test('trimPane keeps the newest lines and characters', () => {
  const pane = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n') + '\n\n';
  const t = trimPane(pane, { maxLines: 3 });
  assert.equal(t, 'line 97\nline 98\nline 99');
  assert.equal(trimPane('abcdef', { maxChars: 3 }), 'def');
  assert.equal(trimPane(null), '');
});

test('buildTriageState fills defaults and only includes finite idle seconds', () => {
  const s = buildTriageState({ pane: 'x' });
  assert.deepEqual(s, { task: { id: 'unknown', brief: '(no brief available)' }, last_status_line: '(none)', pane_tail: 'x' });
  assert.equal(buildTriageState({ pane: 'x', idleSeconds: 30, taskId: 't', brief: 'b', statusLine: 'working: y' }).pane_unchanged_seconds, 30);
  assert.equal('pane_unchanged_seconds' in buildTriageState({ pane: 'x', idleSeconds: NaN }), false);
});

test('every crew state has a hint and is offered to Jev', () => {
  assert.deepEqual(Object.keys(TRIAGE_QUESTIONS.crew_state.criteria), Object.keys(CREW_STATES));
  for (const s of Object.keys(CREW_STATES)) assert.ok(HINTS[s], s);
});

test('decideAction absorbs only a confident, calm working/waiting crew', () => {
  assert.equal(decideAction(triageAnswers()).action, 'absorb');
  assert.equal(decideAction(triageAnswers({ state: 'waiting_external' })).action, 'absorb');
});

test('decideAction wakes on any doubt and lists every reason', () => {
  const r = decideAction(triageAnswers({ state: 'working', conf: 0.5, need: 0.6, loop: 0.8 }));
  assert.equal(r.action, 'wake');
  assert.match(r.reason, /confidence 0.5 < 0.7/);
  assert.match(r.reason, /needs_supervisor 0.6 > 0.3/);
  assert.match(r.reason, /looping 0.8 > 0.5/);
  const d = decideAction(triageAnswers({ state: 'done', need: 0.2 }));
  assert.equal(d.action, 'wake');
  assert.equal(d.reason, 'crew_state=done');
  assert.equal(d.hint, HINTS.done);
});

test('decideAction treats a missing confidence as zero', () => {
  const a = triageAnswers();
  delete a.crew_state.confidence;
  const r = decideAction(a);
  assert.equal(r.action, 'wake');
  assert.equal(r.confidence, null);
});

test('decideAction honours a custom policy', () => {
  assert.equal(decideAction(triageAnswers({ need: 0.4 }), { confidenceFloor: 0.5, maxNeedsSupervisor: 0.5, maxLooping: 0.5 }).action, 'absorb');
});

test('triageWake wakes on a terminal verb without calling Jev', async () => {
  const f = fakeFetch(ok(triageAnswers()));
  const r = await triageWake({ key: 'k', statusLine: 'blocked: no creds', pane: 'x', fetchImpl: f });
  assert.equal(r.action, 'wake');
  assert.equal(r.source, 'verb');
  assert.equal(f.calls.length, 0);
});

test('triageWake asks Jev for non-terminal lines and reports cost/latency', async () => {
  const f = fakeFetch(ok(triageAnswers()));
  const r = await triageWake({ key: 'k', taskId: 't1', statusLine: 'working: x', pane: 'spinner', idleSeconds: 12, fetchImpl: f });
  assert.equal(r.action, 'absorb');
  assert.equal(r.source, 'jev');
  assert.equal(r.cost, 0.000004);
  assert.equal(f.calls[0].body.session_id, 'fm-t1');
  assert.equal(f.calls[0].body.state.pane_unchanged_seconds, 12);
});

test('triageWake handles missing usage and no task id', async () => {
  const f = fakeFetch({ status: 200, body: { model: 'm', answers: triageAnswers({ state: 'failed' }) } });
  const r = await triageWake({ key: 'k', pane: 'crash', fetchImpl: f });
  assert.equal(r.action, 'wake');
  assert.equal(r.cost, null);
  assert.equal('session_id' in f.calls[0].body, false);
});

test('triageWake fails safe to wake when Jev errors', async () => {
  const r = await triageWake({ key: 'k', pane: 'x', fetchImpl: fakeFetch({ status: 400, body: { error: { message: 'bad' } } }) });
  assert.equal(r.action, 'wake');
  assert.equal(r.source, 'error');
  assert.match(r.reason, /failing safe/);
});

import { decideAlreadyReported, SAME_AS_REPORTED } from '../src/triage.mjs';

test('a stale wake after an already-reported terminal verb asks Jev and flags it in state', async () => {
  const f = fakeFetch(ok(triageAnswers({ state: 'done', conf: 0.9, need: 0.6 })));
  const r = await triageWake({ key: 'k', statusLine: 'done: ready in branch x', pane: 'All done.\n>', wakeKind: 'stale', fetchImpl: f });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].body.state.supervisor_already_saw_last_status_line, true);
  assert.equal(r.action, 'absorb');
  assert.match(r.reason, /already reported/);
});

test('a signal wake with a terminal verb still wakes without Jev', async () => {
  const f = fakeFetch(ok(triageAnswers()));
  const r = await triageWake({ key: 'k', statusLine: 'done: x', pane: 'p', wakeKind: 'signal', fetchImpl: f });
  assert.equal(r.source, 'verb');
  assert.equal(f.calls.length, 0);
});

test('decideAlreadyReported wakes when the pane diverged, is unsure, or loops', () => {
  assert.match(decideAlreadyReported(triageAnswers({ state: 'failed' }), 'done').reason, /pane now shows failed/);
  assert.match(decideAlreadyReported(triageAnswers({ state: 'done', conf: 0.4 }), 'done').reason, /confidence 0.4/);
  assert.match(decideAlreadyReported(triageAnswers({ state: 'stuck_or_looping', loop: 0.9 }), 'blocked').reason, /looping 0.9/);
  assert.equal(decideAlreadyReported(triageAnswers({ state: 'needs_decision' }), 'needs-decision').action, 'absorb');
  assert.equal(decideAlreadyReported(triageAnswers({ state: 'failed' }), 'failed').action, 'absorb');
  const a = triageAnswers({ state: 'done' });
  delete a.crew_state.confidence;
  assert.equal(decideAlreadyReported(a, 'done').action, 'wake');
  for (const v of TERMINAL_VERBS) assert.ok(SAME_AS_REPORTED[v], v);
});
