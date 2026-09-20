import { DecisionError, type Answer, type Decision, type Decider, type Questions } from './types.ts';

/**
 * Policy: what you do with an answer once you have it.
 *
 * One rule runs through all of it: a policy may only move a decision towards the safer end of a
 * ladder, never away from it. The model proposes; recorded rules can escalate; a human can do
 * anything. Every move records why, so a decision can be read back later.
 */

export interface Raise<T extends string> {
  /** Raise to this level when `when` is true. `null`/`undefined` means "no floor". */
  to: T | null | undefined;
  when: boolean;
  why: string;
}

export interface Resolved<T extends string> {
  value: T;
  proposed: T;
  raised: boolean;
  confidence: number | null;
  reasons: string[];
}

export const rankIn = <T extends string>(ladder: readonly T[], value: string): number => ladder.indexOf(value as T);

/** Apply floors in order; only ever moves up the ladder. */
export function applyFloors<T extends string>(start: T, ladder: readonly T[], rules: Raise<T>[]): { value: T; raised: boolean; reasons: string[] } {
  let value = start;
  const reasons: string[] = [];
  for (const r of rules) {
    if (!r.when || !r.to) continue;
    if (rankIn(ladder, r.to) > rankIn(ladder, value)) {
      value = r.to;
      reasons.push(r.why);
    }
  }
  return { value, raised: value !== start, reasons };
}

/**
 * When the model is unsure, take the safer of its two most likely options - not a blind step up.
 * "sonnet 0.72 / haiku 0.28" should resolve to sonnet, not to opus.
 */
export function saferOfTopTwo<T extends string>(probabilities: Record<string, number> | undefined, ladder: readonly T[]): T | null {
  const ranked = Object.entries(probabilities ?? {})
    .filter(([k]) => rankIn(ladder, k) >= 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([k]) => k as T);
  if (!ranked.length) return null;
  return ranked.reduce((a, b) => (rankIn(ladder, b) > rankIn(ladder, a) ? b : a));
}

export interface ResolveOptions<T extends string> {
  answer: Answer | undefined;
  ladder: readonly T[];
  /** Below this confidence the choice is resolved towards the safer end. Default 0.6. */
  confidenceFloor?: number;
  floors?: Raise<T>[];
  /** Used when the answer is missing or unusable - the safest level by default. */
  fallback?: T;
}

/**
 * Turn one `choice` answer into a final level: the model's pick, resolved for low confidence,
 * then raised by any floor that applies. Never lowers.
 */
export function resolveChoice<T extends string>({ answer, ladder, confidenceFloor = 0.6, floors = [], fallback }: ResolveOptions<T>): Resolved<T> {
  const safest = fallback ?? ladder[ladder.length - 1];
  if (!answer || answer.type !== 'choice' || rankIn(ladder, answer.choice) < 0) {
    return { value: safest, proposed: safest, raised: true, confidence: null, reasons: [`no usable answer; defaulting to ${safest}`] };
  }
  const proposed = answer.choice as T;
  const confidence = answer.confidence ?? null;
  const reasons = [`proposed ${proposed}${confidence == null ? '' : ` (confidence ${confidence})`}`];
  let value = proposed;
  if ((confidence ?? 0) < confidenceFloor) {
    const safer = saferOfTopTwo(answer.probabilities, ladder) ?? ladder[Math.min(rankIn(ladder, proposed) + 1, ladder.length - 1)];
    if (rankIn(ladder, safer) > rankIn(ladder, value)) {
      reasons.push(`confidence ${confidence} below ${confidenceFloor}: safer of the likely options is ${safer}`);
      value = safer;
    }
  }
  const floored = applyFloors(value, ladder, floors);
  return { value: floored.value, proposed, raised: floored.value !== proposed, confidence, reasons: [...reasons, ...floored.reasons] };
}

/** Machine answers with a human's overrides on top. The human always wins; the diff is recorded. */
export function withOverrides<T extends Record<string, string>>(machine: T, overrides: Partial<T> = {}): { final: T; overridden: (keyof T)[] } {
  const clean = Object.fromEntries(Object.entries(overrides).filter(([k, v]) => v != null && v !== '' && k in machine)) as Partial<T>;
  return { final: { ...machine, ...clean }, overridden: Object.keys(clean) as (keyof T)[] };
}

/**
 * Ask, and if asking fails, carry on with a safe answer instead of throwing.
 * The fallback is recorded as the reason so a log never hides a model outage.
 */
export async function decideOrFallback(decider: Decider, state: unknown, questions: Questions, onError: (e: DecisionError) => Decision): Promise<Decision & { failed?: string }> {
  try {
    return await decider(state, questions);
  } catch (e) {
    const err = e instanceof DecisionError ? e : new DecisionError(String((e as Error).message ?? e));
    return { ...onError(err), failed: err.message };
  }
}
