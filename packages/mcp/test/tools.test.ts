import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, decideTool, routeModel, errorResult, DEFAULT_TIERS, type ToolResult } from '../src/tools.ts';
import { deciderFromEnv, buildServer, guard } from '../src/server.ts';
import type { Decider, Questions } from '@decisis/core';

const body = (r: ToolResult) => JSON.parse(r.content[0].text.split('\n\n').slice(1).join('\n\n'));
const summary = (r: ToolResult) => r.content[0].text.split('\n')[0];

/** A decider that answers from a script and records what it was asked. */
function fake(answers: Record<string, unknown>, seen: { state?: unknown; questions?: Questions } = {}): Decider {
  return async (state, questions) => {
    seen.state = state;
    seen.questions = questions;
    return { answers: answers as never, model: 'fake-model', costUsd: 0.00002, latencyMs: 7 };
  };
}

test('classify returns the pick, confidence and provenance', async () => {
  const seen = {};
  const r = await classify({ state: 'CI failed on a flaky login test', options: { flake: 'a flaky test', real: 'a genuine break', infra: 'infrastructure' }, instructions: 'What kind of failure is this?' },
    fake({ answer: { type: 'choice', choice: 'flake', confidence: 0.82, probabilities: { flake: 0.82, real: 0.1, infra: 0.08 } } }, seen));
  assert.equal(summary(r), 'flake');
  const d = body(r);
  assert.deepEqual([d.value, d.proposed, d.confidence, d.model, d.cost_usd], ['flake', 'flake', 0.82, 'fake-model', 0.00002]);
  assert.equal((seen as { questions: Questions }).questions.answer.type, 'choice');
  assert.match(((seen as { questions: Questions }).questions.answer as { instructions: string }).instructions, /What kind of failure/);
});

test('classify resolves a low-confidence answer along a ladder, and reports the raise', async () => {
  const r = await classify({ state: 's', options: { low: 'low', high: 'high' }, ladder: ['low', 'high'] },
    fake({ answer: { type: 'choice', choice: 'low', confidence: 0.4, probabilities: { low: 0.55, high: 0.45 } } }));
  assert.equal(summary(r), 'high (raised from low)');
  assert.match(body(r).reasons[1], /safer of the likely options is high/);
});

test('classify refuses fewer than two options', async () => {
  const r = await classify({ state: 's', options: { only: 'one' } }, fake({}));
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /at least two/);
  assert.equal((await classify({ state: 's', options: {} } as never, fake({}))).isError, true);
});

test('decide answers several typed questions and prints a readable line', async () => {
  const questions = {
    urgent: { type: 'noul', instructions: 'urgent?' },
    tier: { type: 'choice', instructions: 'tier?', criteria: { a: 'A', b: 'B' } },
    risk: { type: 'score', instructions: 'risk?', criteria: ['Low', 'High'] },
  };
  const r = await decideTool({ state: 's', questions }, fake({ urgent: { type: 'noul', noul: 0.3 }, tier: { type: 'choice', choice: 'b', confidence: 0.7 }, risk: { type: 'score', score: 1 } }));
  assert.equal(summary(r), 'urgent: 0.3 · tier: b (0.7) · risk: High');
  assert.equal(body(r).answers.tier.choice, 'b');
});

test('decide rejects malformed question sets before spending a call', async () => {
  const called = { n: 0 };
  const counting: Decider = async () => { called.n++; return { answers: {}, model: 'm', costUsd: null, latencyMs: 1 }; };
  for (const questions of [{}, { q: { type: 'choice', criteria: { only: 'one' } } }, { q: { type: 'score', criteria: ['single'] } }, { q: { type: 'noul' } }, { q: null }]) {
    const r = await decideTool({ state: 's', questions: questions as Record<string, unknown> }, counting);
    assert.equal(r.isError, true, JSON.stringify(questions));
  }
  assert.equal(called.n, 0);
});

test('route_model picks a tier and raises it for risk or ambiguity', async () => {
  const seen = {};
  const cheap = await routeModel({ task: 'Rename a helper and update call sites' },
    fake({ tier: { type: 'choice', choice: 'haiku', confidence: 0.99 }, risk: { type: 'score', score: 0 }, ambiguity: { type: 'noul', noul: 0.05 } }, seen));
  assert.equal(body(cheap).tier, 'haiku');
  assert.equal(body(cheap).raised, false);
  assert.deepEqual(Object.keys((seen as { questions: Questions }).questions), ['tier', 'risk', 'ambiguity']);

  const risky = await routeModel({ task: 'Zero-downtime migration' },
    fake({ tier: { type: 'choice', choice: 'sonnet', confidence: 0.9 }, risk: { type: 'score', score: 2 }, ambiguity: { type: 'noul', noul: 0.2 } }));
  assert.equal(body(risky).tier, 'opus');
  assert.match(body(risky).reasons[1], /risk High: at least opus/);

  const vague = await routeModel({ task: 'Make search better' },
    fake({ tier: { type: 'choice', choice: 'haiku', confidence: 0.9 }, risk: { type: 'score', score: 0 }, ambiguity: { type: 'noul', noul: 0.9 } }));
  assert.equal(body(vague).tier, 'sonnet');
  assert.match(summary(vague), /needs design decisions/);

  const custom = await routeModel({ task: 't', tiers: ['small', 'large'] },
    fake({ tier: { type: 'choice', choice: 'small', confidence: 0.9 }, risk: { type: 'score', score: 1 }, ambiguity: { type: 'noul', noul: 0 } }));
  assert.equal(body(custom).tier, 'large');
  assert.deepEqual(DEFAULT_TIERS, ['haiku', 'sonnet', 'opus']);
});

test('a failing decider becomes a tool error, not a crash', async () => {
  const r = await guard(async () => { throw new Error('HTTP 401: bad key'); });
  assert.equal(r.isError, true);
  assert.equal(r.content[0].text, 'decisis: HTTP 401: bad key');
  assert.equal(errorResult('x').isError, true);
  const ok = await guard(async () => ({ content: [{ type: 'text' as const, text: 'fine' }] }));
  assert.equal(ok.isError, undefined);
});

test('deciderFromEnv picks the decisions model by default and an LLM when asked', async () => {
  assert.equal(typeof deciderFromEnv({ OPENROUTER_API_KEY: 'k' }), 'function');
  assert.equal(typeof deciderFromEnv({ OPENROUTER_API_KEY: 'k', DECISIS_LLM_MODEL: 'qwen/qwen3-235b-a22b-2507' }), 'function');
  await assert.rejects(deciderFromEnv({})('s', { q: { type: 'noul', instructions: 'x' } }), /no API key/);
});

test('buildServer registers the three tools', () => {
  const server = buildServer(fake({}));
  const names = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
  assert.deepEqual(names.sort(), ['classify', 'decide', 'route_model']);
});
