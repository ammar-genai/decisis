// Routing: ask Jev four typed questions about a task, then apply a floor-only safety policy.
// The policy can only move a task UP a tier, never down: under-routing (a weak model on a hard
// task) is the expensive mistake; over-routing only costs money.
import { jevDecider, resolveChoice, levelOf } from '@decisis/core';

export const TIER_CRITERIA = {
  haiku:
    'Mechanical, fully specified and local: renames, typo or copy fixes, formatting, config tweaks, adding a simple test or docs, boilerplate that copies an existing pattern. One or two files, no design decisions, easy to verify.',
  sonnet:
    'Typical engineering work with a clear goal: implementing a feature or fixing a bug inside the existing architecture, reading several files, writing tests, moderate debugging. Needs solid judgement but no new architecture.',
  opus:
    'Hard or high-stakes work: unclear requirements, architecture or API design, cross-cutting refactors, concurrency, security, data migrations, performance work, or debugging with an unknown cause. Anything where a subtle mistake is costly or hard to spot.',
};

export const COMPLEXITY_LEVELS = ['Trivial', 'Routine', 'Moderate', 'Hard', 'Very hard'];
export const RISK_LEVELS = ['Low', 'Medium', 'High'];

export function buildRouteQuestions(tiers) {
  const criteria = Object.fromEntries(tiers.map((t) => [t, TIER_CRITERIA[t] ?? `Use the ${t} model.`]));
  return {
    tier: {
      type: 'choice',
      instructions: 'Which model should do this engineering task? Pick the CHEAPEST option that will reliably do it well; do not pick a stronger model just in case.',
      criteria,
    },
    complexity: { type: 'score', instructions: 'How technically complex is the task?', criteria: COMPLEXITY_LEVELS },
    risk: { type: 'score', instructions: 'If the change had a subtle mistake, how costly or hard to detect would it be?', criteria: RISK_LEVELS },
    ambiguity: {
      type: 'noul',
      instructions: 'Does doing this task well require design or product decisions that the task does not specify?',
      criteria: { true: 'Open questions about approach, interfaces or behaviour must be decided.', false: 'The task says what to do; only implementation remains.' },
    },
  };
}

export function buildTaskState(task, plan) {
  return {
    project: { goal: plan.goal ?? null, summary: plan.summary ?? null },
    task: { title: task.title, description: task.description, files: task.files ?? [], acceptance: task.acceptance ?? null, depends_on: (task.depends_on ?? []).length },
  };
}

/** Pure: Jev's answers + policy -> final tier with reasons. Floors come from core; they only raise. */
export function applyPolicy(answers, config) {
  const { tiers, policy } = config;
  const complexity = levelOf(answers.complexity, COMPLEXITY_LEVELS);
  const risk = levelOf(answers.risk, RISK_LEVELS);
  const ambiguity = answers.ambiguity.noul;
  const resolved = resolveChoice({
    answer: answers.tier,
    ladder: tiers,
    confidenceFloor: policy.confidenceFloor,
    floors: [
      { to: policy.riskFloor?.[risk], when: true, why: `risk ${risk}: at least ${policy.riskFloor?.[risk]}` },
      { to: policy.complexityFloor?.[complexity], when: true, why: `complexity ${complexity}: at least ${policy.complexityFloor?.[complexity]}` },
      { to: policy.ambiguityFloor, when: ambiguity > policy.ambiguityThreshold, why: `needs design decisions (${ambiguity}): at least ${policy.ambiguityFloor}` },
    ],
  });
  return {
    tier: resolved.value,
    jevTier: resolved.proposed,
    confidence: resolved.confidence,
    probabilities: answers.tier.probabilities ?? null,
    complexity,
    complexityScore: answers.complexity.score,
    risk,
    riskScore: answers.risk.score,
    ambiguity,
    raised: resolved.raised,
    reasons: resolved.reasons,
  };
}

/** Route one task. On a Jev failure, fall back to the strongest tier (never silently cheap). */
export async function routeTask({ key, task, plan, config, decideImpl }) {
  const questions = buildRouteQuestions(config.tiers);
  const decide = decideImpl ?? jevDecider({ key, model: config.jev.model, title: 'decisis-router' });
  try {
    const r = await decide(buildTaskState(task, plan), questions);
    return { ...applyPolicy(r.answers, config), source: 'jev', latencyMs: r.latencyMs, jevCostUsd: r.costUsd ?? null };
  } catch (e) {
    const top = config.tiers.at(-1);
    return { tier: top, jevTier: null, source: 'fallback', raised: true, reasons: [`jev unavailable (${e.message}); defaulting to ${top}`] };
  }
}

export async function routePlan({ key, plan, config, decideImpl }) {
  const routed = await Promise.all(plan.tasks.map((task) => routeTask({ key, task, plan, config, decideImpl })));
  return { ...plan, routedAt: new Date().toISOString(), tasks: plan.tasks.map((t, i) => ({ ...t, route: routed[i] })) };
}
