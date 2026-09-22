import { spawn } from 'node:child_process';
import { schemaFor, toAnswers } from './llm.ts';
import { validateAnswers } from './validate.ts';
import { DecisionError, type Decider } from './types.ts';

/**
 * Typed decisions through the Claude Code CLI (`claude -p --json-schema`), so the whole kit works
 * with nothing but a Claude subscription: no API key, no third-party provider.
 *
 * Trade-offs against a decisions model: a few seconds instead of a few hundred milliseconds,
 * each call carries Claude Code's own prompt overhead (tens of thousands of cached tokens) that
 * draws on the plan's usage window, and the confidence is the model's own estimate rather than a
 * calibrated distribution. Keep the policy floors on.
 */
export interface ClaudeCodeOptions {
  /** `haiku`, `sonnet`, `opus`, or a full model id. Default haiku: crisp decisions rarely need more. */
  model?: string;
  bin?: string;
  timeoutMs?: number;
  cwd?: string;
  spawnImpl?: typeof spawn;
}

export const CLAUDE_CODE_SYSTEM =
  'Answer only the typed questions about the state below, using only the state. Never invent facts. ' +
  'Return exactly the JSON the schema asks for: a probability between 0 and 1, one option from the listed set, or one level from the ordered scale, with a confidence between 0 and 1 where asked.';

export function buildArgs(model: string, questions: Parameters<typeof schemaFor>[0]): string[] {
  return ['-p', '--model', model, '--output-format', 'json', '--json-schema', JSON.stringify(schemaFor(questions)), '--restricted', '--max-turns', '2'];
}

interface CliResult {
  is_error?: boolean;
  subtype?: string;
  result?: string;
  structured_output?: Record<string, never>;
  duration_ms?: number;
  total_cost_usd?: number;
  modelUsage?: Record<string, { canonicalModel?: string }>;
}

export function claudeCodeDecider(opts: ClaudeCodeOptions = {}): Decider {
  const { model = 'haiku', bin = 'claude', timeoutMs = 120000, cwd, spawnImpl = spawn } = opts;
  return (state, questions) =>
    new Promise((resolve, reject) => {
      const t0 = performance.now();
      const child = spawnImpl(bin, buildArgs(model, questions), { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new DecisionError(`claude timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(new DecisionError(`could not start ${bin}: ${e.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        let res: CliResult;
        try {
          res = JSON.parse(out);
        } catch {
          return reject(new DecisionError(`claude exited ${code} without JSON output: ${(err || out).trim().slice(0, 200)}`));
        }
        if (res.is_error || res.subtype !== 'success') return reject(new DecisionError(`claude ${res.subtype ?? 'error'}: ${String(res.result ?? '').slice(0, 200)}`));
        if (!res.structured_output) return reject(new DecisionError('claude returned no structured output'));
        try {
          const answers = validateAnswers(toAnswers(res.structured_output, questions), questions);
          const used = Object.values(res.modelUsage ?? {})[0]?.canonicalModel ?? Object.keys(res.modelUsage ?? {})[0] ?? model;
          // On a subscription nothing is charged per call; the CLI's figure is the list-price equivalent.
          resolve({ answers, model: used, costUsd: null, listPriceUsd: res.total_cost_usd ?? null, latencyMs: Math.round(performance.now() - t0), cliDurationMs: res.duration_ms ?? null });
        } catch (e) {
          reject(e);
        }
      });
      child.stdin.end(`${CLAUDE_CODE_SYSTEM}\n\nState:\n${typeof state === 'string' ? state : JSON.stringify(state, null, 1)}`);
    });
}
