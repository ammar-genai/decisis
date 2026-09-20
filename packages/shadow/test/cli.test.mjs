import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, readFirstmateTask, formatTriage, formatRoute } from '../src/cli.mjs';

const dir = mkdtempSync(join(tmpdir(), 'jev-mate-cli-'));
const paneFile = join(dir, 'pane.txt');
const briefFile = join(dir, 'brief.md');
const rulesFile = join(dir, 'rules.json');
writeFileSync(paneFile, 'running tests');
writeFileSync(briefFile, 'fix typo');
writeFileSync(rulesFile, JSON.stringify({ rules: [{ when: 'x', use: { harness: 'claude' } }] }));

const io = (over = {}) => ({ env: {}, readStdin: () => 'stdin pane', exec: () => 'peeked pane', ...over });
const absorb = { action: 'absorb', source: 'jev', reason: 'jev: working', crewState: 'working', confidence: 0.9, needsSupervisor: 0.1, looping: 0.1, hint: 'nothing to do', model: 'm', latencyMs: 200, cost: 0.00002 };
const captured = () => {
  const seen = [];
  return { seen, triageWake: async (a) => (seen.push(a), absorb), routeTask: async (a) => (seen.push(a), { status: 'clear', rule: 'rule_1', when: 'x', confidence: 0.9, probabilities: { rule_1: 0.9 }, profiles: [{ harness: 'claude', model: 'haiku', effort: 'low' }], model: 'm', latencyMs: 100, cost: 0.00001 }), loadKey: () => 'k' };
};

test('no command or --help prints usage', async () => {
  assert.equal((await run([], { io: io() })).code, 2);
  const h = await run(['--help'], { io: io() });
  assert.equal(h.code, 0);
  assert.match(h.out, /Usage:/);
});

test('unknown flag and unknown command are usage errors', async () => {
  assert.match((await run(['triage', '--bogus'], { io: io() })).out, /error: .*bogus/);
  const r = await run(['frobnicate'], { io: io(), deps: captured() });
  assert.equal(r.code, 2);
  assert.match(r.out, /unknown command "frobnicate"[\s\S]*Usage:/);
});

test('triage from files passes status, pane, brief and idle seconds', async () => {
  const d = captured();
  const r = await run(['triage', '--status', 'working: x', '--pane-file', paneFile, '--brief-file', briefFile, '--idle-seconds', '30'], { io: io(), deps: d });
  assert.equal(r.code, 0);
  assert.match(r.out, /^action: absorb/);
  assert.deepEqual(d.seen[0], { key: 'k', statusLine: 'working: x', pane: 'running tests', brief: 'fix typo', idleSeconds: 30 });
});

test('triage reads the pane from stdin and prints JSON', async () => {
  const d = captured();
  const r = await run(['triage', '--pane-file', '-', '--json'], { io: io(), deps: d });
  assert.equal(JSON.parse(r.out).action, 'absorb');
  assert.equal(d.seen[0].pane, 'stdin pane');
  assert.equal(d.seen[0].statusLine, '');
});

test('triage without --task or --pane-file is a usage error', async () => {
  const r = await run(['triage'], { io: io(), deps: captured() });
  assert.equal(r.code, 2);
  assert.match(r.out, /needs --task/);
});

test('triage --task reads a firstmate home (status tail, brief, fm-peek)', async () => {
  const home = join(dir, 'fm');
  mkdirSync(join(home, 'state'), { recursive: true });
  mkdirSync(join(home, 'data', 't9'), { recursive: true });
  writeFileSync(join(home, 'state', 't9.status'), 'working: a\nworking: b\n');
  writeFileSync(join(home, 'data', 't9', 'brief.md'), 'the brief');
  const d = captured();
  const execs = [];
  await run(['triage', '--task', 't9', '--fm-home', home], { io: io({ exec: (c, a) => (execs.push([c, a]), 'pane!') }), deps: d });
  assert.deepEqual(d.seen[0], { key: 'k', taskId: 't9', statusLine: 'working: b', brief: 'the brief', pane: 'pane!' });
  assert.deepEqual(execs[0], [join(home, 'bin', 'fm-peek.sh'), ['t9', '60']]);
});

test('readFirstmateTask tolerates a missing task and a failing peek', () => {
  const r = readFirstmateTask(join(dir, 'nowhere'), 'x', io({ exec: () => { throw new Error('no such window\nmore'); } }));
  assert.deepEqual(r, { taskId: 'x', statusLine: '', brief: undefined, pane: '(pane unavailable: no such window)' });
});

test('triage --task falls back to FM_HOME from the environment', async () => {
  const d = captured();
  await run(['triage', '--task', 'zz'], { io: io({ env: { FM_HOME: join(dir, 'nowhere') } }), deps: d });
  assert.equal(d.seen[0].taskId, 'zz');
});

test('route reads brief and rules and prints a firstmate-style block', async () => {
  const d = captured();
  const r = await run(['route', '--brief-file', briefFile, '--rules', rulesFile, '--project', 'app'], { io: io(), deps: d });
  assert.equal(r.code, 0);
  assert.match(r.out, /^status: clear/);
  assert.match(r.out, /candidate: --harness claude --model haiku --effort low/);
  assert.equal(d.seen[0].project, 'app');
  assert.equal(d.seen[0].brief, 'fix typo');
  const j = await run(['route', '--brief-file', briefFile, '--rules', rulesFile, '--json'], { io: io(), deps: captured() });
  assert.equal(JSON.parse(j.out).rule, 'rule_1');
});

test('route needs --brief-file and reports a missing rules file', async () => {
  assert.match((await run(['route'], { io: io(), deps: captured() })).out, /route needs --brief-file/);
  const r = await run(['route', '--brief-file', briefFile], { io: io({ env: { FM_HOME: join(dir, 'nowhere') } }), deps: captured() });
  assert.equal(r.code, 2);
  assert.match(r.out, /ENOENT/);
});

test('formatters cover wake/error and non-clear shapes', () => {
  const w = formatTriage({ action: 'wake', source: 'jev', reason: 'crew_state=done', crewState: 'done', confidence: 1, needsSupervisor: 0.5, looping: 0, hint: 'review', model: 'm', latencyMs: 1, cost: 0 });
  assert.match(w, /hint: review/);
  const e = formatTriage({ action: 'wake', source: 'error', reason: 'down', crewState: null });
  assert.equal(e, 'action: wake\n  source: error\n  reason: down');
  assert.equal(formatRoute({ status: 'error', reason: 'down' }), 'status: error\n  reason: down');
  assert.match(formatRoute({ status: 'escalate', reason: 'no rules', profiles: [{ harness: 'codex' }] }), /candidate: --harness codex$/);
});
