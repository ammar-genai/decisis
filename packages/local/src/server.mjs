// The local decider behind a Decisions-shaped HTTP endpoint.
//
// Same request and response as the hosted decisions API, so an existing client points at it with
// one changed line:  jevDecider({ url: 'http://127.0.0.1:8088/decisions', key: 'unused' })
import { createServer } from 'node:http';
import { localDecider } from './decider.mjs';

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) reject(new Error('request too large'));
    });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });

const send = (res, status, body) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
};

/**
 * @param {object} opts  everything localDecider takes, plus `decideImpl` for tests.
 * @returns an http.Server, not yet listening.
 */
export function buildServer({ decideImpl, ...opts } = {}) {
  const decide = decideImpl ?? localDecider(opts);
  return createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true, model: opts.model ?? null });
    if (req.method !== 'POST') return send(res, 405, { error: { message: 'POST a decisions request' } });
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (e) {
      return send(res, 400, { error: { message: `invalid JSON: ${e.message}` } });
    }
    if (!body?.questions || typeof body.questions !== 'object') {
      return send(res, 400, { error: { message: '`questions` is required' } });
    }
    try {
      const r = await decide(body.state, body.questions);
      // `usage.cost` is 0 rather than absent: this decision really did cost nothing.
      return send(res, 200, { answers: r.answers, model: r.model, usage: { cost: 0 }, latency_ms: r.latencyMs });
    } catch (e) {
      return send(res, 500, { error: { message: e.message } });
    }
  });
}

export function serve({ port = 8088, host = '127.0.0.1', ...opts } = {}) {
  const server = buildServer(opts);
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}
