import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyFloors, saferOfTopTwo, resolveChoice, withOverrides, decideOrFallback, rankIn, DecisionError, type Answer, type Decision } from '../src/index.ts';
import { QUESTIONS } from './helpers.ts';

const TIERS = ['small', 'medium', 'large'] as const;
type Tier = (typeof TIERS)[number];
const pick = (choice: Tier, confidence?: number, probabilities?: Record<string, number>): Answer => ({ type: 'choice', choice, confidence, probabilities });

test('rankIn and applyFloors only ever move up the ladder', () => {
  assert.equal(rankIn(TIERS, 'medium'), 1);
  assert.equal(rankIn(TIERS, 'nonsense'), -1);
  const up = applyFloors<Tier>('small', TIERS, [
    { to: 'medium', when: true, why: 'medium risk' },
    { to: 'small', when: true, why: 'should never lower' },
    { to: 'large', when: false, why: 'not triggered' },
    { to: null, when: true, why: 'no floor configured' },
  ]);
  assert.deepEqual(up, { value: 'medium', raised: true, reasons: ['medium risk'] });
  assert.deepEqual(applyFloors<Tier>('large', TIERS, [{ to: 'small', when: true, why: 'x' }]), { value: 'large', raised: false, reasons: [] });
});

test('saferOfTopTwo takes the safer of the two most likely, ignoring unknown labels', () => {
  assert.equal(saferOfTopTwo({ small: 0.28, medium: 0.72, large: 0 }, TIERS), 'medium');
  assert.equal(saferOfTopTwo({ small: 0.5, medium: 0.1, large: 0.4 }, TIERS), 'large');
  assert.equal(saferOfTopTwo({ small: 0.9, unknown: 0.1 }, TIERS), 'small');
  assert.equal(saferOfTopTwo(undefined, TIERS), null);
  assert.equal(saferOfTopTwo({ nothing: 1 }, TIERS), null);
});

test('resolveChoice keeps a confident pick and records why', () => {
  const r = resolveChoice<Tier>({ answer: pick('small', 0.95), ladder: TIERS });
  assert.equal(r.value, 'small');
  assert.equal(r.raised, false);
  assert.deepEqual(r.reasons, ['proposed small (confidence 0.95)']);
});

test('resolveChoice resolves low confidence towards the safer likely option, not blindly upward', () => {
  const two = resolveChoice<Tier>({ answer: pick('small', 0.35, { small: 0.28, medium: 0.72, large: 0 }), ladder: TIERS });
  assert.equal(two.value, 'medium');
  assert.match(two.reasons[1], /safer of the likely options is medium/);
  const noProbs = resolveChoice<Tier>({ answer: pick('small', 0.35), ladder: TIERS });
  assert.equal(noProbs.value, 'medium');
  const atTop = resolveChoice<Tier>({ answer: pick('large', 0.2), ladder: TIERS });
  assert.equal(atTop.value, 'large');
  const custom = resolveChoice<Tier>({ answer: pick('small', 0.5), ladder: TIERS, confidenceFloor: 0.4 });
  assert.equal(custom.value, 'small');
});

test('resolveChoice applies floors after confidence, and falls back safely on a missing answer', () => {
  const floored = resolveChoice<Tier>({ answer: pick('small', 0.99), ladder: TIERS, floors: [{ to: 'large', when: true, why: 'high risk: at least large' }] });
  assert.equal(floored.value, 'large');
  assert.equal(floored.proposed, 'small');
  assert.equal(floored.raised, true);
  assert.deepEqual(floored.reasons, ['proposed small (confidence 0.99)', 'high risk: at least large']);
  for (const answer of [undefined, { type: 'noul', noul: 1 } as Answer, pick('unknown' as Tier, 0.9)]) {
    const r = resolveChoice<Tier>({ answer, ladder: TIERS });
    assert.equal(r.value, 'large');
    assert.match(r.reasons[0], /no usable answer; defaulting to large/);
  }
  assert.equal(resolveChoice<Tier>({ answer: undefined, ladder: TIERS, fallback: 'medium' }).value, 'medium');
  const noConfidence = resolveChoice<Tier>({ answer: pick('medium'), ladder: TIERS });
  assert.equal(noConfidence.confidence, null);
  assert.equal(noConfidence.value, 'large'); // no confidence reported is treated as no confidence
});

test('withOverrides lets a human win and reports what they changed', () => {
  const machine = { notice: 'no', hearing: 'not_reported', timing: 'same_day' };
  const { final, overridden } = withOverrides(machine, { notice: 'yes', bogus: 'x', hearing: '', timing: undefined } as Partial<typeof machine>);
  assert.deepEqual(final, { notice: 'yes', hearing: 'not_reported', timing: 'same_day' });
  assert.deepEqual(overridden, ['notice']);
  assert.deepEqual(withOverrides(machine).final, machine);
});

test('decideOrFallback carries on when the model is unreachable, and records that it did', async () => {
  const fallback = (): Decision => ({ answers: {}, model: 'fallback', costUsd: null, latencyMs: 0 });
  const ok = await decideOrFallback(async () => ({ answers: {}, model: 'jev', costUsd: 1, latencyMs: 2 }), 's', QUESTIONS, fallback);
  assert.equal(ok.model, 'jev');
  assert.equal(ok.failed, undefined);
  const down = await decideOrFallback(async () => { throw new DecisionError('HTTP 500'); }, 's', QUESTIONS, fallback);
  assert.equal(down.model, 'fallback');
  assert.equal(down.failed, 'HTTP 500');
  const weird = await decideOrFallback(async () => { throw new TypeError('boom'); }, 's', QUESTIONS, fallback);
  assert.equal(weird.failed, 'boom');
});
