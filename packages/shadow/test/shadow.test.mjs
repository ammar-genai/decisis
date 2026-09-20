import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseQueue, parseTriageLine, windowToTask, taskForWake, ShadowWatcher, summarize, formatSummary } from '../src/shadow.mjs';
import { run } from '../src/cli.mjs';

function fakeHome() {
  const home = mkdtempSync(join(tmpdir(), 'jev-shadow-'));
  const state = join(home, 'state');
  mkdirSync(state);
  writeFileSync(join(state, 't1.meta'), 'window=old\nwindow=fm-t1\n');
  writeFileSync(join(state, 't2.meta'), 'terminal=term-2\n');
  writeFileSync(join(state, 'notes.txt'), 'ignored');
  return { home, state, log: join(home, 'shadow.jsonl') };
}
const row = (epoch, seq, kind, key, payload = 'p') => `${epoch}\t${seq}\t${kind}\t${key}\t${payload}\n`;
const verdict = (action, crewState = 'working') => ({ action, source: 'jev', crewState, confidence: 0.9, needsSupervisor: 0.1, looping: 0.1, reason: 'r', latencyMs: 250, cost: 0.00004 });

test('parseQueue reads tab rows and drops junk', () => {
  const rows = parseQueue(row(1, 1, 'signal', 'a.status', 'x\ty') + 'garbage\n\n');
  assert.deepEqual(rows, [{ epoch: 1, seq: '1', kind: 'signal', key: 'a.status', payload: 'x\ty' }]);
  assert.deepEqual(parseQueue(undefined), []);
});

test('parseTriageLine extracts window and absorbed flag', () => {
  assert.deepEqual(parseTriageLine('[2026-09-18T10:00:00+0100] absorbed stale (idle 300s): fm-t1'), { ts: '2026-09-18T10:00:00+0100', message: 'absorbed stale (idle 300s): fm-t1', window: 'fm-t1', absorbed: true });
  assert.equal(parseTriageLine('[ts] steer-inbox delivery attempt').absorbed, false);
  assert.equal(parseTriageLine('[ts] no window here').window, null);
  assert.equal(parseTriageLine('not a log line'), null);
});

test('windowToTask matches the latest window= or terminal= like firstmate', () => {
  const { state } = fakeHome();
  assert.equal(windowToTask('fm-t1', state), 't1');
  assert.equal(windowToTask('old', state), null);
  assert.equal(windowToTask('term-2', state), 't2');
  assert.equal(windowToTask('nope', state), null);
  assert.equal(windowToTask(null, state), null);
  assert.equal(windowToTask('x', join(state, 'missing')), null);
});

test('taskForWake handles signal, stale and other kinds', () => {
  const { state } = fakeHome();
  assert.equal(taskForWake({ kind: 'signal', key: 't9.status' }, state), 't9');
  assert.equal(taskForWake({ kind: 'signal', key: 'weird' }, state), null);
  assert.equal(taskForWake({ kind: 'stale', key: 'fm-t1' }, state), 't1');
  assert.equal(taskForWake({ kind: 'check', key: 'pr' }, state), null);
});

test('ShadowWatcher judges only new crew wakes and new absorbed lines', async () => {
  const { home, state, log } = fakeHome();
  writeFileSync(join(state, '.wake-queue'), row(1, 1, 'signal', 't1.status'));
  writeFileSync(join(state, '.watch-triage.log'), '[ts] absorbed stale (old): fm-t1\n');
  const asked = [];
  const w = new ShadowWatcher({
    fmHome: home, logFile: log, now: () => 'NOW',
    triageTask: async (id) => {
      asked.push(id);
      if (id === 'boom') throw new Error('peek failed');
      return { input: { statusLine: 'working: x', pane: 'a\nb' }, result: verdict(id === 't1' ? 'absorb' : 'wake', id === 't1' ? 'working' : 'done') };
    },
  });
  w.primeFromDisk();
  assert.deepEqual(await w.poll(), []); // pre-existing rows are skipped

  appendFileSync(join(state, '.wake-queue'), row(2, 1, 'stale', 'fm-t1', 'stale: fm-t1') + row(2, 2, 'check', 'pr-1') + row(2, 3, 'stale', 'unknown-win') + row(2, 4, 'signal', 'boom.status'));
  appendFileSync(join(state, '.watch-triage.log'), '[ts] absorbed stale (paused): term-2\n[ts] steer-inbox delivery attempt: t2\n[ts] absorbed stale: gone-win\n[ts] partial line wit');
  const recs = await w.poll();
  assert.deepEqual(asked, ['t1', 'boom', 't2']);
  assert.equal(recs.length, 3);
  assert.equal(recs[0].type, 'firstmate_woke');
  assert.deepEqual(recs[0].wake, { kind: 'stale', key: 'fm-t1', payload: 'stale: fm-t1' });
  assert.equal(recs[0].jev.action, 'absorb');
  assert.equal(recs[1].jev.source, 'error');
  assert.equal(recs[1].statusLine, null);
  assert.equal(recs[2].type, 'firstmate_absorbed');
  assert.equal(recs[2].jev.action, 'wake');
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 3);

  appendFileSync(join(state, '.watch-triage.log'), 'h\n');
  assert.deepEqual(await w.poll(), []); // the completed partial line is not "absorbed"

  writeFileSync(join(state, '.watch-triage.log'), '[ts] absorbed x: fm-t1\n'); // rotated (shorter)
  const rotated = await w.poll();
  assert.equal(rotated.length, 1);
  assert.equal(rotated[0].task, 't1');
});

test('ShadowWatcher copes with an empty home', async () => {
  const { home, log } = fakeHome();
  const w = new ShadowWatcher({ fmHome: home, logFile: log, triageTask: async () => ({}) });
  w.primeFromDisk();
  assert.deepEqual(await w.poll(), []);
  assert.match(new ShadowWatcher({ fmHome: home, logFile: log, triageTask: async () => ({}) }).now(), /^\d{4}-/);
});

const rec = (type, action, extra = {}) => ({ at: 'T', type, task: 'x', statusLine: 's', pane: 'p1\np2', jev: { action, source: 'jev', crewState: action === 'absorb' ? 'working' : 'done', confidence: 0.9, reason: 'r', latencyMs: 300, cost: 0.00004 }, ...extra });

test('summarize and formatSummary count agreements and list disagreements', () => {
  const records = [
    rec('firstmate_woke', 'absorb', { wake: { kind: 'stale', payload: 'stale: fm-x' } }),
    rec('firstmate_woke', 'wake', { wake: { kind: 'signal', payload: 'sig' } }),
    rec('firstmate_absorbed', 'wake', { absorbed: 'absorbed stale: fm-x' }),
    rec('firstmate_absorbed', 'absorb', { absorbed: 'absorbed stale: fm-x' }),
    { ...rec('firstmate_woke', 'wake', { wake: { kind: 'stale', payload: 'z' } }), jev: { action: 'wake', source: 'error', reason: 'down' }, statusLine: null },
  ];
  const s = summarize(records);
  assert.equal(s.firstmateWoke, 3);
  assert.deepEqual(s.wokeByKind, { stale: 2, signal: 1 });
  assert.equal(s.jevWouldAbsorb, 1);
  assert.equal(s.firstmateAbsorbed, 2);
  assert.equal(s.jevWouldWake, 1);
  assert.equal(s.errors, 1);
  assert.equal(s.latencyP50, 300);
  assert.deepEqual(s.crewStates, { working: 2, done: 2, error: 1 });
  const text = formatSummary(s);
  assert.match(text, /Jev would have ABSORBED 1/);
  assert.match(text, /Disagreements to review:/);
  assert.match(text, /firstmate=woke {2}jev=absorb/);
  assert.match(text, /firstmate=absorbed {2}jev=wake/);
  const empty = summarize([]);
  assert.equal(empty.latencyP50, null);
  assert.doesNotMatch(formatSummary(empty), /Disagreements/);
  assert.match(formatSummary(empty), /Jev crew states: -/);
});

test('CLI shadow polls a home and shadow-report summarises the log', async () => {
  const { home, state, log } = fakeHome();
  writeFileSync(join(state, '.wake-queue'), '');
  const logs = [];
  let slept = 0;
  const io = {
    env: {}, readStdin: () => '', exec: () => 'pane text',
    sleep: async () => { slept++; appendFileSync(join(state, '.wake-queue'), row(5, 1, 'stale', 'fm-t1')); },
    log: (l) => logs.push(l),
  };
  const deps = { loadKey: () => 'k', maxPolls: 2, triageWake: async (a) => ({ ...verdict('absorb'), seenPane: a.pane }) };
  const r = await run(['shadow', '--fm-home', home, '--log', log, '--interval', '0'], { io, deps });
  assert.equal(r.code, 0);
  assert.equal(slept, 1);
  assert.match(logs[0], /shadowing/);
  assert.match(logs[1], /t1 firstmate=woke jev=absorb \(working\)/);
  const rep = await run(['shadow-report', '--log', log], { io, deps });
  assert.match(rep.out, /Jev would have ABSORBED 1 of them/);
  assert.equal(JSON.parse((await run(['shadow-report', '--log', log, '--json'], { io, deps })).out).firstmateWoke, 1);
  assert.match((await run(['shadow-report', '--log', join(home, 'none.jsonl')], { io, deps })).out, /shadow records: 0/);
});

import { herdrPaneForTask } from '../src/shadow.mjs';

test('herdrPaneForTask reads the last pane id from meta', () => {
  const { state } = fakeHome();
  writeFileSync(join(state, 'h1.meta'), 'backend=herdr\npane_id=w2:p3\nterminal=w2:p4\n');
  assert.equal(herdrPaneForTask('h1', state), 'w2:p4');
  assert.equal(herdrPaneForTask('t1', state), null);
  assert.equal(herdrPaneForTask('missing', state), null);
});

test('ShadowWatcher records herdr state as a third judge, including failures', async () => {
  const { home, state, log } = fakeHome();
  writeFileSync(join(state, 'h1.meta'), 'pane_id=w2:p3\n');
  writeFileSync(join(state, 'h2.meta'), 'pane_id=w2:p9\n');
  writeFileSync(join(state, '.wake-queue'), '');
  const w = new ShadowWatcher({
    fmHome: home, logFile: log,
    triageTask: async () => ({ input: {}, result: verdict('wake', 'needs_decision') }),
    herdrState: async (pane) => { if (pane === 'w2:p9') throw new Error('gone\nx'); return 'blocked'; },
  });
  w.primeFromDisk();
  appendFileSync(join(state, '.wake-queue'), row(9, 1, 'signal', 'h1.status') + row(9, 2, 'signal', 'h2.status') + row(9, 3, 'signal', 't1.status'));
  const recs = await w.poll();
  assert.deepEqual(recs.map((r) => r.herdr), [{ pane: 'w2:p3', state: 'blocked' }, { pane: 'w2:p9', state: 'error', error: 'gone' }, { pane: null, state: 'no-pane' }]);
  appendFileSync(join(state, '.watch-triage.log'), '[ts] absorbed busy: fm-t1\n');
  writeFileSync(join(state, 't1.meta'), 'window=fm-t1\npane_id=w2:p3\n');
  await w.poll();
  const s = summarize(readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)));
  assert.deepEqual(s.herdrStates, { blocked: 2, error: 1, 'no-pane': 1 });
  assert.equal(s.herdrBlockedAbsorbed, 1);
  const text = formatSummary(s);
  assert.match(text, /herdr states: blocked=2 error=1 no-pane=1 {3}\(herdr said blocked on 1 wake\(s\) firstmate absorbed\)/);
  assert.match(text, /herdr=blocked/);
});

test('CLI shadow --herdr asks herdr for the pane state', async () => {
  const { home, state, log } = fakeHome();
  writeFileSync(join(state, 't1.meta'), 'window=fm-t1\npane_id=w2:p5\n');
  writeFileSync(join(state, '.wake-queue'), '');
  const execs = [];
  const io = {
    env: {}, readStdin: () => '', log: () => {},
    exec: (c, a) => { execs.push([c, ...a].join(' ')); return c === 'herdr' ? (a[2] === 'w2:p5' ? '{"result":{"agent":{"agent_status":"blocked"}}}' : '{"result":{}}') : 'pane'; },
    sleep: async () => appendFileSync(join(state, '.wake-queue'), row(7, 1, 'stale', 'fm-t1')),
  };
  await run(['shadow', '--fm-home', home, '--log', log, '--interval', '0', '--herdr'], { io, deps: { loadKey: () => 'k', maxPolls: 2, triageWake: async () => verdict('wake', 'needs_decision') } });
  assert.ok(execs.includes('herdr agent get w2:p5'));
  assert.equal(JSON.parse(readFileSync(log, 'utf8')).herdr.state, 'blocked');
  writeFileSync(join(state, 't1.meta'), 'window=fm-t1\npane_id=w2:p6\n');
  appendFileSync(join(state, '.wake-queue'), row(8, 1, 'stale', 'fm-t1'));
  await run(['shadow', '--fm-home', home, '--log', log, '--interval', '0', '--herdr'], { io: { ...io, sleep: async () => appendFileSync(join(state, '.wake-queue'), row(8, 2, 'stale', 'fm-t1')) }, deps: { loadKey: () => 'k', maxPolls: 2, triageWake: async () => verdict('wake', 'needs_decision') } });
  assert.equal(JSON.parse(readFileSync(log, 'utf8').trim().split('\n').at(-1)).herdr.state, 'no-agent');
});
