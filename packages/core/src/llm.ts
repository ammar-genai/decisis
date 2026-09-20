import { validateAnswers } from './validate.ts';
import { DecisionError, type Answer, type Answers, type Decider, type Questions } from './types.ts';

/**
 * The same typed questions answered by an ordinary chat model through structured outputs
 * (OpenAI-compatible: OpenRouter, OpenAI, and anything that speaks the same shape).
 *
 * Why this exists: a decisions model is faster and far cheaper, but it is one vendor's product.
 * This adapter keeps the questions, the policy and the evaluation sets working without it - and
 * makes "is the cheap decision model actually as good?" a measurable question rather than a guess.
 */
export interface LlmOptions {
  key: string | undefined;
  model: string;
  baseUrl?: string;
  title?: string;
  retries?: number;
  timeoutMs?: number;
  maxTokens?: number;
  /** OpenRouter only: refuse providers that ignore the JSON schema. */
  requireSchemaCapableProvider?: boolean;
  fetchImpl?: typeof fetch;
}

export const SYSTEM_PROMPT =
  'You answer a fixed set of typed questions about the given state. Answer only from the state; never invent facts. ' +
  'For each question return the requested field exactly: a probability between 0 and 1, one option from the listed set, or one level from the ordered scale. ' +
  'Include a confidence between 0 and 1 for choice and level answers. Return JSON only.';

/** The JSON Schema the model must fill in: one property per question, closed and fully required. */
export function schemaFor(questions: Questions): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [name, q] of Object.entries(questions)) {
    if (q.type === 'noul') {
      properties[name] = { type: 'object', additionalProperties: false, required: ['probability'], properties: { probability: { type: 'number', description: `${q.instructions} ${q.criteria ? `true = ${q.criteria.true}; false = ${q.criteria.false}` : ''}`.trim() } } };
    } else if (q.type === 'choice') {
      properties[name] = { type: 'object', additionalProperties: false, required: ['choice', 'confidence'], properties: { choice: { type: 'string', enum: Object.keys(q.criteria), description: `${q.instructions} Options: ${Object.entries(q.criteria).map(([k, v]) => `${k} = ${v}`).join('; ')}` }, confidence: { type: 'number' } } };
    } else {
      properties[name] = { type: 'object', additionalProperties: false, required: ['level', 'confidence'], properties: { level: { type: 'string', enum: q.criteria, description: `${q.instructions} Ordered levels: ${q.criteria.join(' < ')}` }, confidence: { type: 'number' } } };
    }
  }
  return { type: 'object', additionalProperties: false, required: Object.keys(questions), properties };
}

/** Map the model's JSON back onto typed answers (a level becomes its index on the scale). */
export function toAnswers(raw: Record<string, { probability?: number; choice?: string; level?: string; confidence?: number }>, questions: Questions): Answers {
  const answers: Answers = {};
  for (const [name, q] of Object.entries(questions)) {
    const r = raw?.[name];
    if (!r) continue;
    if (q.type === 'noul') answers[name] = { type: 'noul', noul: Number(r.probability) } as Answer;
    else if (q.type === 'choice') answers[name] = { type: 'choice', choice: String(r.choice), confidence: r.confidence } as Answer;
    else {
      const index = q.criteria.indexOf(String(r.level));
      answers[name] = { type: 'score', score: index < 0 ? Number.NaN : index, confidence: r.confidence, legend: Object.fromEntries(q.criteria.map((l, i) => [String(i), l])) } as Answer;
    }
  }
  return answers;
}

export function llmDecider(opts: LlmOptions): Decider {
  const { key, model, baseUrl = 'https://openrouter.ai/api/v1', title = 'decisis', retries = 2, timeoutMs = 120000, maxTokens = 4000, fetchImpl = globalThis.fetch } = opts;
  const requireProvider = opts.requireSchemaCapableProvider ?? baseUrl.includes('openrouter.ai');
  return async (state, questions) => {
    if (!key) throw new DecisionError('no API key: pass `key`');
    const schema = schemaFor(questions);
    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `State:\n${typeof state === 'string' ? state : JSON.stringify(state, null, 1)}` },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'decisions', strict: true, schema } },
      max_tokens: maxTokens,
      temperature: 0,
    };
    if (requireProvider) body.provider = { require_parameters: true };
    let last: DecisionError | null = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const t0 = performance.now();
      let res: Response;
      try {
        res = await fetchImpl(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': title },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        last = new DecisionError(`network error: ${(e as Error).message}`);
        continue;
      }
      const json = (await res.json().catch(() => null)) as { choices?: { message?: { content?: string }; finish_reason?: string }[]; usage?: { cost?: number }; model?: string; error?: { message?: string }; provider?: string } | null;
      if (!res.ok) {
        last = new DecisionError(`HTTP ${res.status}: ${json?.error?.message ?? 'no body'}`, res.status);
        if (res.status === 429 || res.status >= 500) continue;
        throw last;
      }
      const choice = json?.choices?.[0];
      const content = choice?.message?.content;
      if (!content) {
        last = new DecisionError(`empty response from ${json?.provider ?? 'provider'} (finish_reason: ${choice?.finish_reason ?? 'none'})`);
        continue;
      }
      let parsed: Record<string, never>;
      try {
        parsed = JSON.parse(content);
      } catch {
        last = new DecisionError(choice?.finish_reason === 'length' ? 'output truncated at max_tokens' : `model did not return JSON: ${content.slice(0, 120)}`);
        continue;
      }
      try {
        const answers = validateAnswers(toAnswers(parsed, questions), questions);
        return { answers, model: json?.model ?? model, costUsd: json?.usage?.cost ?? null, latencyMs: Math.round(performance.now() - t0) };
      } catch (e) {
        last = e as DecisionError;
      }
    }
    throw last!;
  };
}
