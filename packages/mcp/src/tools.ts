/**
 * The tool implementations, kept as plain functions so they can be tested without a transport.
 * Every tool returns both a short human line and the full JSON, because MCP clients differ in
 * what they show the model.
 */
import { resolveChoice, levelOf, type Decider, type Question, type Questions } from '@decisis/core';

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
  /** MCP tool results are open-ended records; this keeps the SDK's structural type happy. */
  [key: string]: unknown;
}

const result = (summary: string, data: unknown): ToolResult => ({ content: [{ type: 'text', text: `${summary}\n\n${JSON.stringify(data, null, 2)}` }] });
export const errorResult = (message: string): ToolResult => ({ content: [{ type: 'text', text: `decisis: ${message}` }], isError: true });

export interface ClassifyArgs {
  state: string;
  options: Record<string, string>;
  instructions?: string;
  ladder?: string[];
  confidence_floor?: number;
}

/** One choice out of a named set, optionally resolved along a safety ladder. */
export async function classify(args: ClassifyArgs, decide: Decider): Promise<ToolResult> {
  const names = Object.keys(args.options ?? {});
  if (names.length < 2) return errorResult('`options` needs at least two named options');
  const questions: Questions = { answer: { type: 'choice', instructions: args.instructions ?? 'Which option fits the state best?', criteria: args.options } };
  const r = await decide(args.state, questions);
  const a = r.answers.answer;
  const choice = a.type === 'choice' ? a.choice : null;
  const ladder = args.ladder?.length ? args.ladder : null;
  const resolved = ladder ? resolveChoice({ answer: a, ladder, confidenceFloor: args.confidence_floor ?? 0.6 }) : null;
  const value = resolved?.value ?? choice;
  return result(`${value}${resolved?.raised ? ` (raised from ${resolved.proposed})` : ''}`, {
    value,
    proposed: choice,
    confidence: a.type === 'choice' ? a.confidence ?? null : null,
    probabilities: a.type === 'choice' ? a.probabilities ?? null : null,
    reasons: resolved?.reasons ?? [],
    model: r.model,
    latency_ms: r.latencyMs,
    cost_usd: r.costUsd,
  });
}

export interface DecideArgs {
  state: string;
  questions: Record<string, unknown>;
}

/** The full typed-question surface, for callers that want several answers at once. */
export async function decideTool(args: DecideArgs, decide: Decider): Promise<ToolResult> {
  const questions = args.questions as Questions;
  const names = Object.keys(questions ?? {});
  if (!names.length) return errorResult('`questions` must contain at least one question');
  for (const [name, q] of Object.entries(questions)) {
    const ok = q && ((q.type === 'noul' && q.instructions) || (q.type === 'choice' && q.criteria && Object.keys(q.criteria).length >= 2) || (q.type === 'score' && Array.isArray(q.criteria) && q.criteria.length >= 2));
    if (!ok) return errorResult(`question "${name}" is not a valid noul, choice (2+ criteria) or score (2+ levels) question`);
  }
  const r = await decide(args.state, questions);
  const readable = Object.entries(r.answers)
    .map(([name, a]) => `${name}: ${a.type === 'noul' ? a.noul : a.type === 'choice' ? `${a.choice}${a.confidence == null ? '' : ` (${a.confidence})`}` : levelOf(a, (questions[name] as Extract<Question, { type: 'score' }>).criteria) ?? a.score}`)
    .join(' · ');
  return result(readable, { answers: r.answers, model: r.model, latency_ms: r.latencyMs, cost_usd: r.costUsd });
}

export const DEFAULT_TIERS = ['haiku', 'sonnet', 'opus'];
export const TIER_CRITERIA: Record<string, string> = {
  haiku: 'Mechanical, local and fully specified: renames, formatting, a simple test, docs, config edits.',
  sonnet: 'Normal engineering work inside the existing architecture: a feature, a bug fix, tests, moderate debugging.',
  opus: 'Hard or high-stakes: design and architecture, cross-cutting refactors, security, migrations, performance, unknown-cause debugging.',
};

export interface RouteArgs {
  task: string;
  tiers?: string[];
  confidence_floor?: number;
}

/**
 * Model routing for one task: the cheapest tier that will do it well, raised when the work is
 * risky or under-specified. Under-routing is the expensive mistake, so floors only raise.
 */
export async function routeModel(args: RouteArgs, decide: Decider): Promise<ToolResult> {
  const tiers = args.tiers?.length ? args.tiers : DEFAULT_TIERS;
  const criteria = Object.fromEntries(tiers.map((t) => [t, TIER_CRITERIA[t] ?? `Use the ${t} model.`]));
  const RISK = ['Low', 'Medium', 'High'];
  const questions: Questions = {
    tier: { type: 'choice', instructions: 'Which model should do this engineering task? Pick the cheapest that will reliably do it well; do not pick a stronger one just in case.', criteria },
    risk: { type: 'score', instructions: 'If the change had a subtle mistake, how costly or hard to detect would it be?', criteria: RISK },
    ambiguity: { type: 'noul', instructions: 'Does doing this task well require design or product decisions the task does not specify?', criteria: { true: 'Open questions about approach, interfaces or behaviour must be decided.', false: 'The task says what to do; only implementation remains.' } },
  };
  const r = await decide({ task: args.task }, questions);
  const risk = levelOf(r.answers.risk, RISK);
  const ambiguity = r.answers.ambiguity.type === 'noul' ? r.answers.ambiguity.noul : 0;
  const strongest = tiers[tiers.length - 1];
  const middle = tiers[Math.min(1, tiers.length - 1)];
  const resolved = resolveChoice({
    answer: r.answers.tier,
    ladder: tiers,
    confidenceFloor: args.confidence_floor ?? 0.6,
    floors: [
      { to: strongest, when: risk === 'High', why: `risk High: at least ${strongest}` },
      { to: middle, when: risk === 'Medium', why: `risk Medium: at least ${middle}` },
      { to: middle, when: ambiguity > 0.6, why: `needs design decisions (${ambiguity}): at least ${middle}` },
    ],
  });
  return result(`${resolved.value} — ${resolved.reasons.join('; ')}`, {
    tier: resolved.value,
    proposed: resolved.proposed,
    raised: resolved.raised,
    confidence: resolved.confidence,
    risk,
    ambiguity,
    reasons: resolved.reasons,
    model: r.model,
    latency_ms: r.latencyMs,
    cost_usd: r.costUsd,
  });
}
