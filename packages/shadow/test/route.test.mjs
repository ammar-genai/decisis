import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRouteQuestions, validateRules, resolveRoute, routeTask, DEFAULT_WHEN } from '../src/route.mjs';
import { fakeFetch, ok } from './helpers.mjs';

const cfg = {
  rules: [
    { when: 'trivial edits', use: { harness: 'claude', model: 'haiku' } },
    { when: 'payments', approval: 'captain', use: [{ harness: 'claude', model: 'opus' }] },
    { when: 'nothing configured', use: [] },
  ],
  default: [{ harness: 'codex' }],
};
const choice = (c, conf = 0.9) => ({ rule: { type: 'choice', choice: c, confidence: conf, probabilities: { [c]: conf } } });

test('buildRouteQuestions mirrors fm-dispatch-resolve: rule_N options plus default', () => {
  const q = buildRouteQuestions(cfg);
  assert.deepEqual(q.rule.criteria, { rule_1: 'trivial edits', rule_2: 'payments', rule_3: 'nothing configured', default: DEFAULT_WHEN });
  assert.equal(q.rule.type, 'choice');
});

test('validateRules rejects malformed configs', () => {
  assert.throws(() => validateRules(null), /JSON object/);
  assert.throws(() => validateRules({ rules: {} }), /must be an array/);
  assert.throws(() => validateRules({ rules: [{ when: ' ', use: {} }] }), /rule 1 needs a non-empty "when"/);
  assert.throws(() => validateRules({ rules: [{ when: 'x' }] }), /rule 1 needs "use"/);
  assert.deepEqual(validateRules({}), []);
});

test('resolveRoute: clear rule, default, ambiguous, captain approval, empty profiles', () => {
  const clear = resolveRoute(choice('rule_1').rule, cfg);
  assert.equal(clear.status, 'clear');
  assert.deepEqual(clear.profiles, [{ harness: 'claude', model: 'haiku' }]);
  const def = resolveRoute(choice('default').rule, cfg);
  assert.equal(def.status, 'clear');
  assert.equal(def.when, DEFAULT_WHEN);
  assert.deepEqual(def.profiles, [{ harness: 'codex' }]);
  assert.equal(resolveRoute(choice('rule_1', 0.4).rule, cfg).status, 'ambiguous');
  assert.equal(resolveRoute(choice('rule_2').rule, cfg).status, 'escalate');
  assert.match(resolveRoute(choice('rule_3').rule, cfg).reason, /no profiles configured for rule_3/);
  const bare = resolveRoute({ choice: 'default' }, { rules: [] });
  assert.equal(bare.status, 'ambiguous');
  assert.equal(bare.probabilities, null);
});

test('routeTask sends the brief as state and returns the resolution', async () => {
  const f = fakeFetch(ok(choice('rule_1')));
  const r = await routeTask({ key: 'k', brief: 'fix typo', project: 'app', cfg, fetchImpl: f });
  assert.deepEqual(f.calls[0].body.state, { task: { project: 'app', brief: 'fix typo' } });
  assert.equal(r.status, 'clear');
  assert.equal(r.cost, 0.000004);
});

test('routeTask handles missing usage', async () => {
  const f = fakeFetch({ status: 200, body: { model: 'm', answers: choice('default') } });
  assert.equal((await routeTask({ key: 'k', brief: 'b', cfg, fetchImpl: f })).cost, null);
});

test('routeTask escalates with no rules and never calls Jev', async () => {
  const f = fakeFetch(ok(choice('default')));
  const r = await routeTask({ key: 'k', brief: 'b', cfg: { default: { harness: 'codex' } }, fetchImpl: f });
  assert.equal(r.status, 'escalate');
  assert.deepEqual(r.profiles, [{ harness: 'codex' }]);
  assert.equal(f.calls.length, 0);
});

test('routeTask returns status error on API failure but throws on bad config', async () => {
  const r = await routeTask({ key: 'k', brief: 'b', cfg, fetchImpl: fakeFetch({ status: 401, body: { error: { message: 'no auth' } } }) });
  assert.equal(r.status, 'error');
  assert.match(r.reason, /no auth/);
  await assert.rejects(routeTask({ key: 'k', brief: 'b', cfg: { rules: [{}] } }), /needs a non-empty "when"/);
});
