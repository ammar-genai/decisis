import type { Questions } from '../src/types.ts';

export const QUESTIONS: Questions = {
  urgent: { type: 'noul', instructions: 'Is it urgent?', criteria: { true: 'needs action now', false: 'can wait' } },
  tier: { type: 'choice', instructions: 'Which tier?', criteria: { small: 'cheap and simple', medium: 'normal work', large: 'hard or risky' } },
  risk: { type: 'score', instructions: 'How risky?', criteria: ['Low', 'Medium', 'High'] },
};

export const ANSWERS = {
  urgent: { type: 'noul', noul: 0.4 },
  tier: { type: 'choice', choice: 'medium', confidence: 0.8, probabilities: { small: 0.15, medium: 0.8, large: 0.05 } },
  risk: { type: 'score', score: 1 },
} as const;

/** Queue of fake HTTP responses; records every request. */
export function fakeFetch(...responses: ({ status: number; body?: unknown } | Error)[]) {
  const calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(init.body as string), headers: init.headers as Record<string, string> });
    const r = responses.length > 1 ? responses.shift()! : responses[0];
    if (r instanceof Error) throw r;
    return { ok: r.status < 300, status: r.status, json: async () => (r.body === undefined ? Promise.reject(new Error('no json')) : r.body) } as unknown as Response;
  }) as unknown as typeof fetch & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

export const chat = (content: unknown, over: Record<string, unknown> = {}) => ({
  status: 200,
  body: { choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) }, finish_reason: 'stop' }], usage: { cost: 0.0004 }, model: 'test/model', ...over },
});
