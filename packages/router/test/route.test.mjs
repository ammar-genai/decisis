import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRouteQuestions, buildTaskState, applyPolicy, routeTask, routePlan, TIER_CRITERIA } from '../src/route.mjs';
import { DEFAULT_CONFIG, mergeConfig } from '../src/config.mjs';
import { answers } from './helpers.mjs';

const task = { id: 't1', title: 'Do x', description: 'desc', files: ['a.ts'], depends_on: ['t0'], acceptance: 'tests pass' };

test('questions cover every tier with criteria, plus complexity, risk and ambiguity', () => {
  const q = buildRouteQuestions(['haiku', 'sonnet', 'opus']);
  assert.deepEqual(Object.keys(q.tier.criteria), ['haiku', 'sonnet', 'opus']);
  assert.equal(q.tier.criteria.opus, TIER_CRITERIA.opus);
  assert.equal(q.complexity.type, 'score');
  assert.equal(q.risk.criteria.length, 3);
  assert.equal(q.ambiguity.type, 'noul');
  assert.equal(buildRouteQuestions(['haiku', 'fable']).tier.criteria.fable, 'Use the fable model.');
});

test('task state includes project context and a dependency count', () => {
  assert.deepEqual(buildTaskState(task, { goal: 'g', summary: 's' }), { project: { goal: 'g', summary: 's' }, task: { title: 'Do x', description: 'desc', files: ['a.ts'], acceptance: 'tests pass', depends_on: 1 } });
  assert.deepEqual(buildTaskState({ title: 'y', description: 'z' }, {}).task, { title: 'y', description: 'z', files: [], acceptance: null, depends_on: 0 });
});

test('policy keeps a confident, low-risk pick', () => {
  const r = applyPolicy(answers({ tier: 'haiku', conf: 0.95 }), DEFAULT_CONFIG);
  assert.equal(r.tier, 'haiku');
  assert.equal(r.raised, false);
  assert.equal(r.complexity, 'Routine');
  assert.equal(r.risk, 'Low');
});

test('low confidence takes the stronger of the top two tiers, or one tier up without probabilities', () => {
  const r = applyPolicy(answers({ tier: 'haiku', conf: 0.4, probs: { haiku: 0.55, sonnet: 0.45, opus: 0 } }), DEFAULT_CONFIG);
  assert.equal(r.tier, 'sonnet');
  assert.match(r.reasons[1], /safer of the likely options is sonnet/);
  const a = answers({ tier: 'haiku', conf: 0.4 });
  delete a.tier.probabilities;
  const up = applyPolicy(a, DEFAULT_CONFIG);
  assert.equal(up.tier, 'sonnet');
  assert.match(up.reasons[1], /safer of the likely options is sonnet/);
  const top = answers({ tier: 'opus', conf: 0.3, probs: { opus: 0.5, sonnet: 0.5 } });
  assert.equal(applyPolicy(top, DEFAULT_CONFIG).tier, 'opus');
  const noConf = answers({ tier: 'opus' });
  delete noConf.tier.confidence;
  delete noConf.tier.probabilities;
  const nc = applyPolicy(noConf, DEFAULT_CONFIG);
  assert.equal(nc.tier, 'opus');
  assert.equal(nc.confidence, null);
  assert.equal(nc.probabilities, null);
});

test('risk, complexity and ambiguity floors only ever raise the tier', () => {
  assert.equal(applyPolicy(answers({ tier: 'haiku', risk: 2 }), DEFAULT_CONFIG).tier, 'opus');
  assert.equal(applyPolicy(answers({ tier: 'haiku', risk: 1 }), DEFAULT_CONFIG).tier, 'sonnet');
  assert.equal(applyPolicy(answers({ tier: 'sonnet', complexity: 4 }), DEFAULT_CONFIG).tier, 'opus');
  const amb = applyPolicy(answers({ tier: 'haiku', amb: 0.9 }), DEFAULT_CONFIG);
  assert.equal(amb.tier, 'sonnet');
  assert.match(amb.reasons.at(-1), /design decisions/);
  assert.equal(applyPolicy(answers({ tier: 'opus', risk: 1, amb: 0.9 }), DEFAULT_CONFIG).tier, 'opus');
  assert.equal(applyPolicy(answers({ tier: 'haiku', complexity: 9, risk: -1 }), DEFAULT_CONFIG).complexity, 'Very hard');
  const lax = mergeConfig(DEFAULT_CONFIG, { policy: { riskFloor: { High: null, Medium: null }, complexityFloor: null } });
  assert.equal(applyPolicy(answers({ tier: 'haiku', risk: 2, complexity: 4 }), lax).tier, 'haiku');
});

test('routeTask asks Jev and reports cost; falls back to the top tier on errors', async () => {
  let seen;
  const r = await routeTask({ key: 'k', task, plan: {}, config: DEFAULT_CONFIG, decideImpl: async (state, questions) => ((seen = { state, questions }), { answers: answers({ tier: 'haiku', conf: 0.99 }), latencyMs: 200, costUsd: 0.00003 }) });
  assert.equal(r.tier, 'haiku');
  assert.equal(r.source, 'jev');
  assert.equal(r.jevCostUsd, 0.00003);
  assert.equal(seen.state.task.title, 'Do x');
  assert.ok(seen.questions.tier);
  const noUsage = await routeTask({ key: 'k', task, plan: {}, config: DEFAULT_CONFIG, decideImpl: async () => ({ answers: answers() }) });
  assert.equal(noUsage.jevCostUsd, null);
  const f = await routeTask({ key: 'k', task, plan: {}, config: DEFAULT_CONFIG, decideImpl: async () => { throw new Error('HTTP 500'); } });
  assert.equal(f.tier, 'opus');
  assert.equal(f.source, 'fallback');
  assert.match(f.reasons[0], /jev unavailable \(HTTP 500\); defaulting to opus/);
});

test('routePlan attaches a route to every task', async () => {
  const routed = await routePlan({ key: 'k', plan: { summary: 's', tasks: [task, { ...task, id: 't2' }] }, config: DEFAULT_CONFIG, decideImpl: async () => ({ answers: answers() }) });
  assert.equal(routed.tasks.length, 2);
  assert.equal(routed.tasks[1].route.tier, 'sonnet');
  assert.ok(routed.routedAt);
});
