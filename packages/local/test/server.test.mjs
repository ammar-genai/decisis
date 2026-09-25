import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jevDecider } from '@decisis/core';
import { buildServer } from '../src/server.mjs';

const QUESTIONS = { tier: { type: 'choice', instructions: 'which?', criteria: { haiku: 'a tiny edit', opus: 'a hard problem' } } };
const fakeDecide = async (state, questions) => ({
  answers: Object.fromEntries(Object.keys(questions).map((n) => [n, { type: 'choice', choice: 'opus', confidence: 0.9, probabilities: { haiku: 0.1, opus: 0.9 } }])),
  model: 'local:test',
  costUsd: 0,
  latencyMs: 7,
});

/** Start on an ephemeral port so tests never collide with a running server. */
const start = async (opts = {}) => {
  const server = buildServer({ decideImpl: fakeDecide, ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
};

test('the unmodified decisions client works against the local server', async () => {
  const { server, url } = await start();
  try {
    // This is the whole point: the same client, one changed option.
    const decide = jevDecider({ url: `${url}/decisions`, key: 'unused' });
    const r = await decide({ task: { title: 'migrate the orders table' } }, QUESTIONS);
    assert.equal(r.answers.tier.choice, 'opus');
    assert.equal(r.costUsd, 0);
    assert.equal(r.model, 'local:test');
  } finally {
    server.close();
  }
});

test('bad requests get a reason and a status, never a crash', async () => {
  const { server, url } = await start();
  try {
    const post = (body) => fetch(`${url}/decisions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });

    const badJson = await post('{not json');
    assert.equal(badJson.status, 400);
    assert.match((await badJson.json()).error.message, /invalid JSON/);

    const noQuestions = await post(JSON.stringify({ state: 'x' }));
    assert.equal(noQuestions.status, 400);
    assert.match((await noQuestions.json()).error.message, /questions/);

    assert.equal((await fetch(`${url}/decisions`, { method: 'PUT' })).status, 405);

    const health = await fetch(`${url}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);
  } finally {
    server.close();
  }
});

test('a failure inside the model is returned as an error body, not a dropped socket', async () => {
  const { server, url } = await start({ decideImpl: async () => { throw new Error('model not downloaded'); } });
  try {
    const res = await fetch(`${url}/decisions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: 's', questions: QUESTIONS }) });
    assert.equal(res.status, 500);
    assert.match((await res.json()).error.message, /model not downloaded/);
  } finally {
    server.close();
  }
});
