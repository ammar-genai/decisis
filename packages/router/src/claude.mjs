// Run one headless Claude Code turn: `claude -p --output-format json [--model ...] [--json-schema ...]`.
// The prompt goes in on stdin so long plans never hit argv limits.
import { spawn } from 'node:child_process';

export function buildArgs({ model, schema, permissionMode, allowedTools, disallowedTools, maxBudgetUsd, appendSystemPrompt }) {
  const args = ['-p', '--output-format', 'json'];
  if (model) args.push('--model', model);
  if (schema) args.push('--json-schema', JSON.stringify(schema));
  if (permissionMode) args.push('--permission-mode', permissionMode);
  if (allowedTools?.length) args.push('--allowedTools', allowedTools.join(','));
  if (disallowedTools?.length) args.push('--disallowedTools', disallowedTools.join(','));
  if (maxBudgetUsd != null) args.push('--max-budget-usd', String(maxBudgetUsd));
  if (appendSystemPrompt) args.push('--append-system-prompt', appendSystemPrompt);
  return args;
}

/** Normalise the `--output-format json` result object. */
export function parseClaudeResult(raw) {
  const models = Object.entries(raw.modelUsage ?? {});
  return {
    ok: raw.is_error === false && raw.subtype === 'success',
    subtype: raw.subtype ?? null,
    result: raw.result ?? null,
    structured: raw.structured_output ?? null,
    costUsd: raw.total_cost_usd ?? 0,
    model: models.map(([id, u]) => u.canonicalModel ?? id).join('+') || null,
    modelUsage: raw.modelUsage ?? {},
    numTurns: raw.num_turns ?? null,
    durationMs: raw.duration_ms ?? null,
    permissionDenials: Array.isArray(raw.permission_denials) ? raw.permission_denials.length : 0,
    sessionId: raw.session_id ?? null,
  };
}

export function runClaude(prompt, opts = {}, { cwd = process.cwd(), timeoutMs = 20 * 60 * 1000, spawnImpl = spawn, bin = 'claude' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(bin, buildArgs(opts), { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`claude timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`could not start claude: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      let raw;
      try {
        raw = JSON.parse(out);
      } catch {
        return reject(new Error(`claude exited ${code} without JSON output: ${(err || out).trim().slice(0, 300)}`));
      }
      resolve(parseClaudeResult(raw));
    });
    child.stdin.end(prompt);
  });
}
