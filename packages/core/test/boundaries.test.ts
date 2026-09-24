/**
 * Regression tests for three ways a bad answer used to slip through the boundary.
 * Each of these once produced a confident, wrong, *valid-looking* decision.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateAnswers, toAnswers, resolveChoice, type Answers, type Questions } from '../src/index.ts';
import { QUESTIONS, ANSWERS } from './helpers.ts';

test('a choice inherited from Object.prototype is not a valid option', () => {
  // `choice in criteria` walked the prototype chain, so these passed as real options.
  for (const choice of ['toString', 'constructor', 'hasOwnProperty', 'valueOf', '__proto__', 'isPrototypeOf']) {
    assert.throws(
      () => validateAnswers({ ...ANSWERS, tier: { type: 'choice', choice } } as Answers, QUESTIONS),
      /malformed/,
      `"${choice}" must be rejected`,
    );
  }
  // A real option still passes, and an ordinary unknown one is still rejected.
  assert.doesNotThrow(() => validateAnswers({ ...ANSWERS, tier: { type: 'choice', choice: 'small' } } as Answers, QUESTIONS));
  assert.throws(() => validateAnswers({ ...ANSWERS, tier: { type: 'choice', choice: 'enormous' } } as Answers, QUESTIONS), /malformed/);
});

test('a missing probability is rejected, never coerced to a confident zero', () => {
  const q: Questions = { urgent: QUESTIONS.urgent };
  // Number(null) and Number('') are both 0, which reads as "definitely not urgent".
  for (const probability of [null, undefined, '', '   ', 'abc', {}, []]) {
    const answers = toAnswers({ urgent: { probability } } as never, q);
    assert.throws(() => validateAnswers(answers, q), /missing|malformed/, `${JSON.stringify(probability)} must be rejected`);
  }
  // A genuine zero is a real answer and must survive validation untouched.
  const zero = toAnswers({ urgent: { probability: 0 } }, q);
  assert.deepEqual(zero.urgent, { type: 'noul', noul: 0 });
  assert.doesNotThrow(() => validateAnswers(zero, q));
  assert.deepEqual(toAnswers({ urgent: { probability: '0.7' } } as never, q).urgent, { type: 'noul', noul: 0.7 });
});

test('floors still apply when there is no usable answer', () => {
  const ladder = ['haiku', 'sonnet', 'opus'] as const;
  const floor = [{ to: 'opus' as const, when: true, why: 'touches auth: at least opus' }];

  // A lowered fallback says "start here when the model is silent", not "ignore the rails".
  const raised = resolveChoice({ answer: undefined, ladder, floors: floor, fallback: 'haiku' });
  assert.equal(raised.value, 'opus');
  assert.deepEqual(raised.reasons, ['no usable answer; defaulting to haiku', 'touches auth: at least opus']);

  // An inactive floor leaves the caller's fallback alone.
  assert.equal(resolveChoice({ answer: undefined, ladder, floors: [{ to: 'opus', when: false, why: 'n/a' }], fallback: 'haiku' }).value, 'haiku');

  // An answer naming something outside the ladder is "no usable answer" too.
  assert.equal(resolveChoice({ answer: { type: 'choice', choice: 'gpt' }, ladder, floors: floor, fallback: 'haiku' }).value, 'opus');

  // With no fallback the safest rung is still the default.
  assert.equal(resolveChoice({ answer: undefined, ladder }).value, 'opus');
});
