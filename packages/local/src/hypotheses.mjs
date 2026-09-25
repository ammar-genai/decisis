// Turning a typed decisis question into natural-language inference (NLI) hypotheses.
//
// An NLI model scores "does this premise entail this hypothesis?". The state is the premise, and
// each option becomes one hypothesis; a softmax over the entailment scores is the distribution.
// That is the whole trick, and it is why this runs in milliseconds on a CPU with no API key.
//
// The consequence to keep in mind: the model never reads the question's `instructions`. It only
// compares the state against each option's text. So option descriptions have to be self-contained
// sentences - "a mechanical, local change such as a rename" works, "Mechanical and local." does not.

export const DEFAULT_TEMPLATE = 'This example is {}.';

/** Text for one option: its description if there is one, otherwise its name. */
export const optionText = (name, description) => {
  const d = String(description ?? '').trim();
  return d || String(name);
};

/**
 * The hypotheses for a question, in a fixed order, plus how to read the result back.
 * Returns null for a question type this decider cannot answer.
 */
export function hypothesesFor(question) {
  if (!question || typeof question !== 'object') return null;
  if (question.type === 'choice') {
    const names = Object.keys(question.criteria ?? {});
    if (names.length < 2) return null;
    return { kind: 'choice', names, texts: names.map((n) => optionText(n, question.criteria[n])) };
  }
  if (question.type === 'noul') {
    // A noul is a two-option choice: "true" against "false", read back as one probability.
    const c = question.criteria ?? {};
    const yes = optionText('it is true', c.true);
    const no = optionText('it is not true', c.false);
    return { kind: 'noul', names: ['true', 'false'], texts: [yes, no] };
  }
  if (question.type === 'score') {
    const levels = question.criteria ?? [];
    if (!Array.isArray(levels) || levels.length < 2) return null;
    return { kind: 'score', names: levels.map(String), texts: levels.map(String) };
  }
  return null;
}

/**
 * Read a distribution over hypotheses back as a decisis answer.
 * `scores` is aligned with `names`, sums to 1, and is highest-first only by name lookup.
 */
export function answerFrom(spec, scores) {
  const byName = Object.fromEntries(spec.names.map((n, i) => [n, scores[i]]));
  if (spec.kind === 'noul') return { type: 'noul', noul: round(byName.true) };
  const top = spec.names.reduce((a, b) => (byName[b] > byName[a] ? b : a));
  if (spec.kind === 'choice') {
    return { type: 'choice', choice: top, confidence: round(byName[top]), probabilities: Object.fromEntries(spec.names.map((n) => [n, round(byName[n])])) };
  }
  // A score is the index of the winning level, with the same distribution attached as a legend.
  return {
    type: 'score',
    score: spec.names.indexOf(top),
    confidence: round(byName[top]),
    legend: Object.fromEntries(spec.names.map((n, i) => [String(i), n])),
    probabilities: Object.fromEntries(spec.names.map((n) => [n, round(byName[n])])),
  };
}

const round = (x) => Math.round((Number(x) || 0) * 10000) / 10000;

/**
 * The state as a premise. Objects become readable "key: value" lines rather than raw JSON.
 *
 * `focus` names the top-level keys worth judging. This matters more than it looks: an NLI model
 * weighs the whole premise, so shared context repeated on every call - the project blurb, the
 * stack, the CI setup - pulls every decision the same way and drowns out the part that differs.
 * Measured on the router's 30-task set, focusing on the task alone moved the local decider from
 * 13/30 acceptable to 23/30. A strong model ignores that boilerplate; a 140M-parameter one cannot.
 */
export function premiseOf(state, { focus = null, maxChars = 2000 } = {}) {
  if (typeof state === 'string') return clip(state, maxChars);
  if (!state || typeof state !== 'object') return String(state ?? '');
  const picked = focus?.length ? Object.fromEntries(Object.entries(state).filter(([k]) => focus.includes(k))) : state;
  const source = Object.keys(picked).length ? picked : state;
  return clip(flatten(source).join('\n'), maxChars);
}

const clip = (s, n) => (s.length <= n ? s : `${s.slice(0, n)}…`);

function flatten(value, prefix = '') {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap((v) => flatten(v, prefix));
  if (typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => flatten(v, prefix ? `${prefix} ${k}` : k));
  return [prefix ? `${prefix}: ${value}` : String(value)];
}
