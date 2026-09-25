// A Decider that runs entirely on this machine: no API key, no network after the first download.
//
// It satisfies the same contract as jevDecider and claudeCodeDecider, so it drops into the same
// policy, the same MCP server and the same evaluation sets.
import { hypothesesFor, answerFrom, premiseOf, DEFAULT_TEMPLATE } from './hypotheses.mjs';

// Measured on the router's 30-task set: this one 23/30 acceptable, nli-deberta-v3-small 13/30.
// It is a model trained for zero-shot classification rather than plain MNLI, and it shows.
export const DEFAULT_MODEL = 'MoritzLaurer/deberta-v3-base-zeroshot-v1.1-all-33';

/** Smaller and about twice as fast, at a real cost in accuracy. */
export const SMALL_MODEL = 'Xenova/nli-deberta-v3-small';

/** A question with its criteria replaced by NLI-friendly phrasings, when the caller supplied any. */
const withLabels = (question, override) => (override ? { ...question, criteria: override } : question);

/** Loads the pipeline once and reuses it. Kept separate so tests can pass their own classifier. */
export function loadClassifier({ model = DEFAULT_MODEL, dtype = 'q8', device = undefined } = {}) {
  let pending = null;
  return () =>
    (pending ??= import('@huggingface/transformers')
      .catch(() => {
        // An optional peer dependency of about 1.2 GB. Say so, rather than leaving a bare
        // ERR_MODULE_NOT_FOUND for someone who installed decisis and never asked for a model.
        throw new Error('@decisis/local needs the model runtime: npm install @huggingface/transformers (about 1.2 GB, installed once)');
      })
      .then(({ pipeline }) => pipeline('zero-shot-classification', model, { dtype, device })));
}

/**
 * @param {object} opts
 * @param {string} [opts.model]      a zero-shot (NLI) model id on the Hugging Face hub
 * @param {string} [opts.template]   hypothesis template; `{}` is replaced by the option text
 * @param {object} [opts.labels]   per-question hypothesis text, overriding the question's own
 *                                  `criteria`. Criteria are usually written as instructions to a
 *                                  large model ("Mechanical, fully specified and local: ..."); an
 *                                  NLI model wants a natural phrase that completes the template
 *                                  ("a mechanical, local change such as a rename"). Shape matches
 *                                  the question: an object of option -> phrase for a choice or a
 *                                  noul, an array of phrases for a score.
 * @param {string[]} [opts.focus]    top-level state keys to judge on; others are left out of the
 *                                  premise. Use it to drop context that is the same on every call.
 * @param {number} [opts.maxChars]  premise length cap (default 2000)
 * @param {Function} [opts.classifyImpl] (premise, hypotheses, opts) => { labels, scores }
 */
export function localDecider({ model = DEFAULT_MODEL, template = DEFAULT_TEMPLATE, labels = {}, focus = null, maxChars = 2000, dtype, device, classifyImpl } = {}) {
  const get = classifyImpl ? null : loadClassifier({ model, dtype, device });
  return async (state, questions) => {
    const started = Date.now();
    const premise = premiseOf(state, { focus, maxChars });
    const classify = classifyImpl ?? (await get());
    const answers = {};
    const unanswered = [];
    for (const [name, question] of Object.entries(questions ?? {})) {
      const spec = hypothesesFor(withLabels(question, labels[name]));
      if (!spec) {
        unanswered.push(name);
        continue;
      }
      const out = await classify(premise, spec.texts, { hypothesis_template: template, multi_label: false });
      // The pipeline returns labels sorted by score; put them back in the order we asked.
      const scores = spec.texts.map((t) => out.scores[out.labels.indexOf(t)] ?? 0);
      answers[name] = answerFrom(spec, scores);
    }
    return {
      answers,
      model: `local:${model}`,
      costUsd: 0,
      latencyMs: Date.now() - started,
      ...(unanswered.length ? { unanswered } : {}),
    };
  };
}
