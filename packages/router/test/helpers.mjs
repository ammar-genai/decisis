import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const tmp = (p = 'jev-router-') => mkdtempSync(join(tmpdir(), p));

/** A fake child_process.spawn: emits the given stdout and exit code, records args and stdin. */
export function fakeSpawn({ stdout = '', stderr = '', code = 0, error = null, hang = false } = {}) {
  const calls = [];
  const fn = (bin, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    let stdin = '';
    child.stdin = { end: (s) => (stdin = s) };
    child.kill = () => (child.killed = true);
    calls.push({ bin, args, opts, get stdin() { return stdin; } });
    if (!hang) {
      setImmediate(() => {
        if (error) return child.emit('error', error);
        if (stdout) child.stdout.emit('data', stdout);
        if (stderr) child.stderr.emit('data', stderr);
        child.emit('close', code);
      });
    }
    return child;
  };
  fn.calls = calls;
  return fn;
}

export const claudeJson = (over = {}) => ({
  type: 'result', subtype: 'success', is_error: false, result: 'ok', total_cost_usd: 0.05, num_turns: 3, duration_ms: 1200, session_id: 's1',
  modelUsage: { 'claude-sonnet-5': { canonicalModel: 'claude-sonnet-5', costUSD: 0.05 } }, permission_denials: [], ...over,
});

export const answers = ({ tier = 'sonnet', conf = 0.9, probs, complexity = 1, risk = 0, amb = 0.1 } = {}) => ({
  tier: { type: 'choice', choice: tier, confidence: conf, probabilities: probs ?? { [tier]: conf } },
  complexity: { type: 'score', score: complexity },
  risk: { type: 'score', score: risk },
  ambiguity: { type: 'noul', noul: amb },
});
