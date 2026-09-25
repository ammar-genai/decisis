import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAnswers } from '@decisis/core';
import { hypothesesFor, answerFrom, premiseOf, localDecider, DEFAULT_TEMPLATE } from '../src/index.mjs';

const QUESTIONS = {
  tier: { type: 'choice', instructions: 'which?', criteria: { haiku: 'a tiny edit', sonnet: 'a normal task', opus: 'a hard problem' } },
  risk: { type: 'score', instructions: 'how risky?', criteria: ['Low', 'Medium', 'High'] },
  ambiguity: { type: 'noul', instructions: 'ambiguous?', criteria: { true: 'under-specified', false: 'fully specified' } },
};

/** Scores the hypotheses in the order given, then returns them sorted, as the real pipeline does. */
const fakeClassifier = (weights) => async (premise, texts) => {
  const scored = texts.map((t, i) => ({ t, s: weights[i] ?? 0 }));
  const sorted = [...scored].sort((a, b) => b.s - a.s);
  return { sequence: premise, labels: sorted.map((x) => x.t), scores: sorted.map((x) => x.s) };
};

test('each question type becomes hypotheses and comes back as a typed answer', () => {
  const choice = hypothesesFor(QUESTIONS.tier);
  assert.deepEqual(choice.names, ['haiku', 'sonnet', 'opus']);
  assert.deepEqual(choice.texts, ['a tiny edit', 'a normal task', 'a hard problem']);
  assert.deepEqual(answerFrom(choice, [0.1, 0.2, 0.7]), {
    type: 'choice', choice: 'opus', confidence: 0.7, probabilities: { haiku: 0.1, sonnet: 0.2, opus: 0.7 },
  });

  const noul = hypothesesFor(QUESTIONS.ambiguity);
  assert.deepEqual(noul.texts, ['under-specified', 'fully specified']);
  assert.deepEqual(answerFrom(noul, [0.8, 0.2]), { type: 'noul', noul: 0.8 });

  const score = hypothesesFor(QUESTIONS.risk);
  const s = answerFrom(score, [0.1, 0.15, 0.75]);
  assert.equal(s.score, 2);
  assert.deepEqual(s.legend, { 0: 'Low', 1: 'Medium', 2: 'High' });

  // An option name stands in when a criterion has no description.
  assert.deepEqual(hypothesesFor({ type: 'choice', criteria: { yes: '', no: null } }).texts, ['yes', 'no']);
});

test('questions this decider cannot answer are reported, not guessed at', async () => {
  const bad = [null, {}, { type: 'choice', criteria: { only: 'one' } }, { type: 'score', criteria: ['Solo'] }, { type: 'mystery' }];
  for (const q of bad) assert.equal(hypothesesFor(q), null, JSON.stringify(q));

  const decide = localDecider({ classifyImpl: fakeClassifier([0.7, 0.3]) });
  const r = await decide('state', { ok: QUESTIONS.ambiguity, broken: { type: 'choice', criteria: { one: 'x' } } });
  assert.ok(r.answers.ok);
  assert.equal(r.answers.broken, undefined);
  assert.deepEqual(r.unanswered, ['broken']);
});

test('answers satisfy the core contract, so the policy and MCP server accept them', async () => {
  const decide = localDecider({ classifyImpl: fakeClassifier([0.1, 0.2, 0.7]) });
  const r = await decide({ task: { title: 't' } }, QUESTIONS);
  assert.doesNotThrow(() => validateAnswers(r.answers, QUESTIONS));
  assert.equal(r.costUsd, 0, 'a local decision costs nothing');
  assert.match(r.model, /^local:/);
});

test('scores are read back by name, not by the order the classifier returns them', async () => {
  // The pipeline sorts its output by score; reading positionally would silently invert answers.
  const decide = localDecider({ classifyImpl: fakeClassifier([0.75, 0.15, 0.1]) });
  const r = await decide('s', { tier: QUESTIONS.tier });
  assert.equal(r.answers.tier.choice, 'haiku');
  assert.equal(r.answers.tier.probabilities.haiku, 0.75);
});

test('labels override the question criteria, and the template is passed through', async () => {
  const seen = [];
  const spy = async (premise, texts, opts) => {
    seen.push({ premise, texts, opts });
    return { labels: texts, scores: texts.map((_, i) => (i === 0 ? 0.6 : 0.2)) };
  };
  const decide = localDecider({ classifyImpl: spy, template: 'This task is {}.', labels: { tier: { haiku: 'trivial', sonnet: 'routine', opus: 'hard' } } });
  await decide('some state', { tier: QUESTIONS.tier });
  assert.deepEqual(seen[0].texts, ['trivial', 'routine', 'hard'], 'criteria written for a large model are replaced');
  assert.equal(seen[0].opts.hypothesis_template, 'This task is {}.');
  assert.equal(DEFAULT_TEMPLATE, 'This example is {}.');
});

test('premiseOf flattens state, focuses on the keys that matter, and clips', () => {
  const state = { project: { goal: 'big e-commerce platform', stack: 'Postgres' }, task: { title: 'Fix a typo', files: ['a.ts'] } };
  assert.equal(premiseOf('plain text'), 'plain text');
  assert.match(premiseOf(state), /project goal: big e-commerce platform/);

  // Focus drops the context that is identical on every call and swamps a small model.
  const focused = premiseOf(state, { focus: ['task'] });
  assert.equal(focused, 'task title: Fix a typo\ntask files: a.ts');
  assert.doesNotMatch(focused, /e-commerce/);

  // A focus that matches nothing falls back to the whole state rather than an empty premise.
  assert.match(premiseOf(state, { focus: ['nope'] }), /project goal/);
  assert.equal(premiseOf('x'.repeat(50), { maxChars: 10 }), `${'x'.repeat(10)}…`);
});
