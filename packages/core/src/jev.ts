import { validateAnswers } from './validate.ts';
import { DecisionError, type Decider, type Questions } from './types.ts';

/** OpenRouter's Decisions endpoint. Note it is NOT under /api/v1. */
export const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
export const DEFAULT_JEV_MODEL = 'typesafe/jev-1.13';

export interface JevOptions {
  key: string | undefined;
  model?: string;
  url?: string;
  /** Grouping id for the provider's own observability; never sent to the model. */
  sessionId?: string;
  title?: string;
  retries?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface DecisionsBody {
  answers?: Record<string, never>;
  model?: string;
  usage?: { cost?: number };
  error?: { message?: string };
}

/**
 * TypeSafe Jev (or any decisions model served the same way) through OpenRouter.
 * Retries network errors, 429 and 5xx; fails fast on 4xx.
 */
export function jevDecider(opts: JevOptions): Decider {
  const { key, model = DEFAULT_JEV_MODEL, url = DECISIONS_URL, sessionId, title = 'decisis', retries = 2, timeoutMs = 15000, fetchImpl = globalThis.fetch } = opts;
  return async (state: unknown, questions: Questions) => {
    if (!key) throw new DecisionError('no API key: pass `key` (OPENROUTER_API_KEY)');
    const body = JSON.stringify(sessionId ? { model, state, questions, session_id: sessionId } : { model, state, questions });
    let last: DecisionError | null = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const t0 = performance.now();
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': title },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        last = new DecisionError(`network error: ${(e as Error).message}`);
        continue;
      }
      const json = (await res.json().catch(() => null)) as DecisionsBody | null;
      if (!res.ok) {
        last = new DecisionError(`HTTP ${res.status}: ${json?.error?.message ?? 'no body'}`, res.status);
        if (res.status === 429 || res.status >= 500) continue;
        throw last;
      }
      return { answers: validateAnswers(json?.answers, questions), model: json?.model ?? model, costUsd: json?.usage?.cost ?? null, latencyMs: Math.round(performance.now() - t0) };
    }
    throw last!;
  };
}
