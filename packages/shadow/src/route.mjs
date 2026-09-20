// Dispatch routing: which config/crew-dispatch.json rule fits a task brief?
// Mirrors firstmate's bin/fm-dispatch-resolve.sh question (one Choice over every rule's
// `when` plus a fixed "default" option), but goes through OpenRouter instead of
// api.typesafe.ai. Quota ranking, floors and spendPriority are firstmate's job (jq in
// fm-dispatch-resolve.sh) and deliberately left out of this prototype.
import { jevDecider, DEFAULT_JEV_MODEL as DEFAULT_MODEL } from '@decisis/core';

// Same neutral option text as fm-dispatch-resolve.sh's DEFAULT_WHEN.
export const DEFAULT_WHEN = 'No listed rule applies to this task.';
export const ROUTE_CONFIDENCE_FLOOR = 0.6; // same as fm-dispatch-resolve.sh

export function validateRules(cfg) {
  if (!cfg || typeof cfg !== 'object') throw new Error('dispatch config must be a JSON object');
  const rules = cfg.rules ?? [];
  if (!Array.isArray(rules)) throw new Error('"rules" must be an array');
  rules.forEach((r, i) => {
    if (typeof r?.when !== 'string' || !r.when.trim()) throw new Error(`rule ${i + 1} needs a non-empty "when"`);
    if (!r.use) throw new Error(`rule ${i + 1} needs "use"`);
  });
  return rules;
}

export function buildRouteQuestions(cfg) {
  const rules = validateRules(cfg);
  const criteria = Object.fromEntries(rules.map((r, i) => [`rule_${i + 1}`, r.when]));
  criteria.default = DEFAULT_WHEN;
  return {
    rule: {
      type: 'choice',
      instructions:
        "Which ONE dispatch rule best fits `task` (read `task.brief` and `task.project`)? Each option is the rule's own matching condition; pick `default` when no rule's condition is met, including when a rule's own exemption text excludes this task.",
      criteria,
    },
  };
}

const asArray = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

/** Pure: map Jev's rule answer to firstmate-style status + candidate profiles. */
export function resolveRoute(answer, cfg, floor = ROUTE_CONFIDENCE_FLOOR) {
  const rules = cfg.rules ?? [];
  const idx = /^rule_(\d+)$/.exec(answer.choice)?.[1];
  const rule = idx ? rules[Number(idx) - 1] : null;
  const out = {
    rule: answer.choice,
    when: rule ? rule.when : DEFAULT_WHEN,
    confidence: answer.confidence ?? null,
    probabilities: answer.probabilities ?? null,
    profiles: rule ? asArray(rule.use) : asArray(cfg.default),
  };
  if ((answer.confidence ?? 0) < floor) return { ...out, status: 'ambiguous', reason: `confidence ${answer.confidence} below floor ${floor}` };
  if (rule?.approval === 'captain') return { ...out, status: 'escalate', reason: 'rule requires the captain\'s explicit approval before dispatch' };
  if (out.profiles.length === 0) return { ...out, status: 'escalate', reason: `no profiles configured for ${answer.choice}` };
  return { ...out, status: 'clear' };
}

/** Route one brief. Never throws on API trouble: returns status "error" so firstmate decides as today. */
export async function routeTask({ key, brief, project = '', cfg, model = DEFAULT_MODEL, decideImpl, ...rest }) {
  const questions = buildRouteQuestions(cfg); // config errors DO throw: actionable, never selected around
  if ((cfg.rules ?? []).length === 0) return { status: 'escalate', reason: 'no rules to match', profiles: asArray(cfg.default) };
  try {
    const decide = decideImpl ?? jevDecider({ key, model, title: 'decisis-shadow', ...rest });
    const r = await decide({ task: { project, brief } }, questions);
    return { ...resolveRoute(r.answers.rule, cfg), model: r.model, latencyMs: r.latencyMs, cost: r.costUsd ?? null };
  } catch (e) {
    return { status: 'error', reason: e.message };
  }
}
