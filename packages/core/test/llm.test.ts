import { test } from 'node:test';
import assert from 'node:assert/strict';
import { llmDecider, schemaFor, toAnswers, DecisionError } from '../src/index.ts';
import { QUESTIONS, fakeFetch, chat } from './helpers.ts';

const GOOD = { urgent: { probability: 0.4 }, tier: { choice: 'medium', confidence: 0.8 }, risk: { level: 'High', confidence: 0.6 } };

test('schemaFor builds a closed, fully-required schema with the options inline', () => {
  const s = schemaFor(QUESTIONS) as { required: string[]; additionalProperties: boolean; properties: Record<string, { properties: Record<string, { enum?: string[]; description?: string }> }> };
  assert.deepEqual(s.required, ['urgent', 'tier', 'risk']);
  assert.equal(s.additionalProperties, false);
  assert.deepEqual(s.properties.tier.properties.choice.enum, ['small', 'medium', 'large']);
  assert.match(s.properties.tier.properties.choice.description!, /small = cheap and simple/);
  assert.deepEqual(s.properties.risk.properties.level.enum, ['Low', 'Medium', 'High']);
  assert.match(s.properties.urgent.properties.probability.description!, /true = needs action now/);
});

test('toAnswers maps a level back to its position on the scale', () => {
  const a = toAnswers(GOOD, QUESTIONS);
  assert.deepEqual(a.urgent, { type: 'noul', noul: 0.4 });
  assert.deepEqual(a.tier, { type: 'choice', choice: 'medium', confidence: 0.8 });
  assert.equal(a.risk.type === 'score' && a.risk.score, 2);
  assert.equal(a.risk.type === 'score' && a.risk.legend!['2'], 'High');
  assert.equal(toAnswers({ ...GOOD, risk: { level: 'Unknown' } }, QUESTIONS).risk.type === 'score' && Number.isNaN((toAnswers({ ...GOOD, risk: { level: 'Unknown' } }, QUESTIONS).risk as { score: number }).score), true);
  assert.deepEqual(toAnswers({}, QUESTIONS), {});
});

test('llmDecider sends structured outputs and returns typed answers', async () => {
  const f = fakeFetch(chat(GOOD));
  const r = await llmDecider({ key: 'k', model: 'qwen/qwen3-235b-a22b-2507', fetchImpl: f })({ task: 'x' }, QUESTIONS);
  const body = f.calls[0].body as { response_format: { json_schema: { strict: boolean } }; provider?: { require_parameters: boolean }; messages: { content: string }[] };
  assert.equal(f.calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(body.response_format.json_schema.strict, true);
  assert.deepEqual(body.provider, { require_parameters: true });
  assert.match(body.messages[1].content, /"task": "x"/);
  assert.equal(r.answers.tier.type === 'choice' && r.answers.tier.choice, 'medium');
  assert.equal(r.costUsd, 0.0004);
  assert.equal(r.model, 'test/model');
});

test('llmDecider drops the OpenRouter-only provider hint for other hosts, and takes a string state as-is', async () => {
  const f = fakeFetch(chat(GOOD));
  await llmDecider({ key: 'k', model: 'gpt-x', baseUrl: 'https://api.openai.com/v1', fetchImpl: f })('plain text state', QUESTIONS);
  const body = f.calls[0].body as { provider?: unknown; messages: { content: string }[] };
  assert.equal(body.provider, undefined);
  assert.match(body.messages[1].content, /State:\nplain text state/);
});

test('llmDecider retries empty replies, bad JSON and schema mismatches, then reports the last reason', async () => {
  const empty = { status: 200, body: { choices: [{ message: {}, finish_reason: 'stop' }], provider: 'SomeHost' } };
  assert.ok(await llmDecider({ key: 'k', model: 'm', fetchImpl: fakeFetch(empty, chat(GOOD)) })('s', QUESTIONS));
  await assert.rejects(llmDecider({ key: 'k', model: 'm', retries: 0, fetchImpl: fakeFetch(empty) })('s', QUESTIONS), /empty response from SomeHost/);
  await assert.rejects(llmDecider({ key: 'k', model: 'm', retries: 0, fetchImpl: fakeFetch(chat('not json at all')) })('s', QUESTIONS), /did not return JSON/);
  await assert.rejects(llmDecider({ key: 'k', model: 'm', retries: 0, fetchImpl: fakeFetch(chat('{"a":', { choices: [{ message: { content: '{"a":' }, finish_reason: 'length' }] })) })('s', QUESTIONS), /truncated at max_tokens/);
  await assert.rejects(llmDecider({ key: 'k', model: 'm', retries: 0, fetchImpl: fakeFetch(chat({ ...GOOD, tier: { choice: 'gigantic', confidence: 1 } })) })('s', QUESTIONS), (e) => e instanceof DecisionError && /"tier" is malformed/.test(e.message));
});

test('llmDecider handles HTTP failures and a missing key', async () => {
  await assert.rejects(llmDecider({ key: undefined, model: 'm' })('s', QUESTIONS), /no API key/);
  await assert.rejects(llmDecider({ key: 'k', model: 'm', retries: 0, fetchImpl: fakeFetch({ status: 401, body: { error: { message: 'bad key' } } }) })('s', QUESTIONS), /HTTP 401: bad key/);
  const f = fakeFetch({ status: 502, body: {} }, chat(GOOD));
  assert.ok(await llmDecider({ key: 'k', model: 'm', fetchImpl: f })('s', QUESTIONS));
  assert.equal(f.calls.length, 2);
  await assert.rejects(llmDecider({ key: 'k', model: 'm', retries: 1, fetchImpl: fakeFetch(new Error('ETIMEDOUT')) })('s', QUESTIONS), /network error: ETIMEDOUT/);
});
