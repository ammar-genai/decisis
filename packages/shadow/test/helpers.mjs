// Fake fetch returning queued responses; records every request.
export function fakeFetch(...responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const r = responses.length > 1 ? responses.shift() : responses[0];
    if (r instanceof Error) throw r;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => (r.body === undefined ? Promise.reject(new Error('no json')) : r.body) };
  };
  fn.calls = calls;
  return fn;
}

export const triageAnswers = ({ state = 'working', conf = 0.95, need = 0.1, loop = 0.1 } = {}) => ({
  crew_state: { type: 'choice', choice: state, confidence: conf, probabilities: { [state]: conf } },
  needs_supervisor: { type: 'noul', noul: need },
  looping: { type: 'noul', noul: loop },
});

export const ok = (answers, extra = {}) => ({ status: 200, body: { model: 'typesafe/jev-1.13-test', answers, usage: { input_tokens: 100, output_tokens: 10, cost: 0.000004 }, id: 'gen-1', ...extra } });
