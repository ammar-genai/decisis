import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateAnswers, choiceOf, noulOf, scoreOf, confidenceOf, levelOf, loadKey, keyFromFile, DecisionError, jevDecider, DECISIONS_URL, DEFAULT_JEV_MODEL, type Answers } from '../src/index.ts';
import { QUESTIONS, ANSWERS, fakeFetch } from './helpers.ts';

test('answer readers narrow types without repeating the checks', () => {
  assert.equal(choiceOf(ANSWERS.tier), 'medium');
  assert.equal(choiceOf(ANSWERS.urgent), null);
  assert.equal(noulOf(ANSWERS.urgent), 0.4);
  assert.equal(noulOf(undefined), null);
  assert.equal(scoreOf(ANSWERS.risk), 1);
  assert.equal(confidenceOf(ANSWERS.tier), 0.8);
  assert.equal(confidenceOf(ANSWERS.urgent), null);
  assert.equal(levelOf(ANSWERS.risk, ['Low', 'Medium', 'High']), 'Medium');
  assert.equal(levelOf({ type: 'score', score: 9 }, ['Low', 'High']), 'High');
  assert.equal(levelOf({ type: 'score', score: -3 }, ['Low', 'High']), 'Low');
  assert.equal(levelOf(ANSWERS.tier, ['Low']), null);
  assert.equal(levelOf(ANSWERS.risk, []), null);
});

test('validateAnswers accepts good answers and rejects every broken shape', () => {
  assert.doesNotThrow(() => validateAnswers(ANSWERS as unknown as Answers, QUESTIONS));
  const bad = (answers: unknown, re: RegExp) => assert.throws(() => validateAnswers(answers as Answers, QUESTIONS), re);
  bad(null, /contains no answers/);
  bad({ ...ANSWERS, urgent: undefined }, /"urgent" is missing/);
  bad({ ...ANSWERS, urgent: { type: 'choice', choice: 'small' } }, /is not a noul/);
  bad({ ...ANSWERS, urgent: { type: 'noul', noul: 1.4 } }, /"urgent" is malformed/);
  bad({ ...ANSWERS, tier: { type: 'choice', choice: 'enormous' } }, /"tier" is malformed/);
  bad({ ...ANSWERS, tier: { type: 'choice', choice: 'small', confidence: 3 } }, /"tier" is malformed/);
  bad({ ...ANSWERS, risk: { type: 'score', score: 7 } }, /"risk" is malformed/);
  assert.doesNotThrow(() => validateAnswers({ ...ANSWERS, tier: { type: 'choice', choice: 'small' } } as Answers, QUESTIONS));
});

test('jevDecider posts the decisions body, returns cost and latency', async () => {
  const f = fakeFetch({ status: 200, body: { answers: ANSWERS, model: 'jev-1.13-2026', usage: { cost: 0.00002 } } });
  const d = jevDecider({ key: 'k', fetchImpl: f, sessionId: 'task-7' });
  const r = await d({ task: 'rename a helper' }, QUESTIONS);
  assert.equal(f.calls[0].url, DECISIONS_URL);
  assert.equal(f.calls[0].headers.Authorization, 'Bearer k');
  assert.deepEqual(f.calls[0].body, { model: DEFAULT_JEV_MODEL, state: { task: 'rename a helper' }, questions: QUESTIONS, session_id: 'task-7' });
  assert.equal(r.model, 'jev-1.13-2026');
  assert.equal(r.costUsd, 0.00002);
  assert.ok(Number.isInteger(r.latencyMs));
  const plain = await jevDecider({ key: 'k', fetchImpl: fakeFetch({ status: 200, body: { answers: ANSWERS } }) })('s', QUESTIONS);
  assert.equal('session_id' in (f.calls[0].body as object), true);
  assert.equal(plain.model, DEFAULT_JEV_MODEL);
  assert.equal(plain.costUsd, null);
});

test('jevDecider retries 5xx, 429 and network errors, then fails with the last error', async () => {
  const ok = { status: 200, body: { answers: ANSWERS } };
  const f = fakeFetch({ status: 503, body: {} }, { status: 429, body: { error: { message: 'slow down' } } }, ok);
  assert.ok(await jevDecider({ key: 'k', fetchImpl: f })('s', QUESTIONS));
  assert.equal(f.calls.length, 3);
  await assert.rejects(jevDecider({ key: 'k', retries: 1, fetchImpl: fakeFetch(new Error('ECONNRESET')) })('s', QUESTIONS), /network error: ECONNRESET/);
  await assert.rejects(jevDecider({ key: 'k', retries: 0, fetchImpl: fakeFetch({ status: 500, body: {} }) })('s', QUESTIONS), (e) => e instanceof DecisionError && e.status === 500);
});

test('jevDecider fails fast on 4xx and on a missing key', async () => {
  const f = fakeFetch({ status: 400, body: undefined });
  await assert.rejects(jevDecider({ key: 'k', fetchImpl: f })('s', QUESTIONS), /HTTP 400: no body/);
  assert.equal(f.calls.length, 1);
  await assert.rejects(jevDecider({ key: undefined })('s', QUESTIONS), /no API key/);
});

test('key loading: environment first, then files, never a partial key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'decisis-'));
  const f = join(dir, '.env');
  writeFileSync(f, 'OTHER=1\nOPENROUTER_API_KEY= sk-from-file \n');
  assert.equal(loadKey('OPENROUTER_API_KEY', { env: { OPENROUTER_API_KEY: ' sk-env ' }, files: [f] }), 'sk-env');
  assert.equal(loadKey('OPENROUTER_API_KEY', { env: {}, files: [join(dir, 'nope'), f] }), 'sk-from-file');
  assert.equal(loadKey('MISSING', { env: {}, files: [f] }), null);
  assert.equal(loadKey('OPENROUTER_API_KEY', { env: { OPENROUTER_API_KEY: '   ' }, files: [f] }), 'sk-from-file');
  assert.equal(keyFromFile(join(dir, 'nope'), 'X'), null);
  assert.equal(keyFromFile(f, 'OTHER'), '1');
});
