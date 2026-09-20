/**
 * A typed question. The three shapes match what a decision model can answer without writing prose:
 * a probability (`noul`), one option out of a fixed set (`choice`), or a position on an ordered
 * scale (`score`). Every question carries its own instructions, so a decision is self-describing.
 */
export type Question =
  | { type: 'noul'; instructions: string; criteria?: { true: string; false: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] };

export type Answer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; confidence?: number; probabilities?: Record<string, number> }
  | { type: 'score'; score: number; confidence?: number; probabilities?: Record<string, number>; legend?: Record<string, string> };

export type Questions = Record<string, Question>;
export type Answers = Record<string, Answer>;

export interface Decision {
  answers: Answers;
  /** Model that actually answered, as the provider reports it. */
  model: string;
  costUsd: number | null;
  latencyMs: number;
}

/**
 * Anything that can answer typed questions about some state: TypeSafe Jev through OpenRouter,
 * an ordinary LLM through structured outputs, or a stub in a test. Keeping this an interface is
 * deliberate - the decision model is the part most likely to change.
 */
export type Decider = (state: unknown, questions: Questions) => Promise<Decision>;

export class DecisionError extends Error {
  status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'DecisionError';
    this.status = status;
  }
}

// ---- reading answers without repeating the type narrowing everywhere ----
export const choiceOf = (a: Answer | undefined): string | null => (a?.type === 'choice' ? a.choice : null);
export const noulOf = (a: Answer | undefined): number | null => (a?.type === 'noul' ? a.noul : null);
export const scoreOf = (a: Answer | undefined): number | null => (a?.type === 'score' ? a.score : null);
export const confidenceOf = (a: Answer | undefined): number | null => (a && a.type !== 'noul' ? a.confidence ?? null : null);

/** The label a `score` answer lands on, given the question's ordered criteria. */
export function levelOf(a: Answer | undefined, levels: readonly string[]): string | null {
  const s = scoreOf(a);
  if (s == null || !levels.length) return null;
  return levels[Math.min(levels.length - 1, Math.max(0, Math.round(s)))];
}
