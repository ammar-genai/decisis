import { DecisionError, type Answers, type Questions } from './types.ts';

const isProb = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1;

/**
 * Membership must be an own-property test. `in` walks the prototype chain, so a model answering
 * "toString" or "__proto__" would otherwise pass as a legitimate choice.
 */
const isOption = (criteria: Record<string, string>, choice: string): boolean => Object.hasOwn(criteria, choice);

/**
 * Every asked question must come back with an answer of the right shape and range. A decision you
 * cannot trust is worse than no decision, so this throws rather than returning something partial.
 */
export function validateAnswers(answers: Answers | undefined | null, questions: Questions): Answers {
  if (!answers || typeof answers !== 'object') throw new DecisionError('response contains no answers');
  for (const [name, q] of Object.entries(questions)) {
    const a = answers[name];
    if (!a || a.type !== q.type) throw new DecisionError(`answer "${name}" is missing or is not a ${q.type}`);
    const ok =
      (a.type === 'noul' && isProb(a.noul)) ||
      (a.type === 'choice' && q.type === 'choice' && typeof a.choice === 'string' && isOption(q.criteria, a.choice) && (a.confidence === undefined || isProb(a.confidence))) ||
      (a.type === 'score' && q.type === 'score' && typeof a.score === 'number' && a.score >= 0 && a.score <= q.criteria.length - 1);
    if (!ok) throw new DecisionError(`answer "${name}" is malformed`);
  }
  return answers;
}
