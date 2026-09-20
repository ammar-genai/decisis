// CLI logic (kept separate from bin/ so tests can drive it without spawning processes).
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadKey } from '@decisis/core';
import { fileURLToPath } from 'node:url';
import { triageWake } from './triage.mjs';
import { routeTask } from './route.mjs';
import { ShadowWatcher, summarize, formatSummary } from './shadow.mjs';

export const USAGE = `decisis-shadow - record what a decision model would have decided, without acting

Usage:
  decisis-shadow triage --task <id> [--fm-home <dir>] [--json]
      Reads <fm-home>/state/<id>.status (last line), <fm-home>/data/<id>/brief.md and the
      pane tail via <fm-home>/bin/fm-peek.sh <id> 60.
  decisis-shadow triage [--status "<line>"] [--pane-file <f|->] [--brief-file <f>] [--idle-seconds <n>] [--json]
  decisis-shadow route --brief-file <f> [--rules <crew-dispatch.json>] [--project <name>] [--json]
  decisis-shadow shadow [--fm-home <dir>] [--log <file.jsonl>] [--interval <sec>] [--herdr]
      Read-only sidecar: for every crewmate wake firstmate delivers or absorbs, record what
      Jev would have decided. Runs until killed. Default log: jev-mate/shadow.jsonl.
      --herdr also records herdr's native agent state for the task's pane (third judge).
  decisis-shadow shadow-report [--log <file.jsonl>] [--json]

Key: OPENROUTER_API_KEY environment variable or .env.
Output: a firstmate-style block whose first line is "action: absorb|wake" (triage) or
"status: clear|ambiguous|escalate|error" (route). Always exits 0 unless the usage is wrong.
`;

const OPTIONS = {
  task: { type: 'string' },
  'fm-home': { type: 'string' },
  status: { type: 'string' },
  'pane-file': { type: 'string' },
  'brief-file': { type: 'string' },
  'idle-seconds': { type: 'string' },
  rules: { type: 'string' },
  project: { type: 'string' },
  log: { type: 'string' },
  interval: { type: 'string' },
  json: { type: 'boolean' },
  herdr: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

export class UsageError extends Error {}

const readText = (f, io) => (f === '-' ? io.readStdin() : readFileSync(f, 'utf8'));

/** Gather triage inputs from a live firstmate home. */
export function readFirstmateTask(fmHome, taskId, io) {
  const statusFile = join(fmHome, 'state', `${taskId}.status`);
  const briefFile = join(fmHome, 'data', taskId, 'brief.md');
  const statusLine = existsSync(statusFile) ? readFileSync(statusFile, 'utf8').trimEnd().split('\n').at(-1) : '';
  const brief = existsSync(briefFile) ? readFileSync(briefFile, 'utf8') : undefined;
  let pane = '';
  try {
    pane = io.exec(join(fmHome, 'bin', 'fm-peek.sh'), [taskId, '60']);
  } catch (e) {
    pane = `(pane unavailable: ${e.message.split('\n')[0]})`;
  }
  return { taskId, statusLine, brief, pane };
}

export function formatTriage(r) {
  const lines = [`action: ${r.action}`, `  source: ${r.source}`, `  reason: ${r.reason}`];
  if (r.crewState) lines.push(`  crew_state: ${r.crewState} (confidence ${r.confidence})   needs_supervisor: ${r.needsSupervisor}   looping: ${r.looping}`);
  if (r.hint && r.action === 'wake') lines.push(`  hint: ${r.hint}`);
  if (r.latencyMs != null) lines.push(`  model: ${r.model}   latency_ms: ${r.latencyMs}   cost: $${r.cost}`);
  return lines.join('\n');
}

export function formatRoute(r) {
  const lines = [`status: ${r.status}`];
  if (r.rule) lines.push(`  rule: ${r.rule} (${String(r.when).slice(0, 70)})   confidence: ${r.confidence}`);
  if (r.probabilities) lines.push(`  probabilities: ${Object.entries(r.probabilities).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  if (r.reason) lines.push(`  reason: ${r.reason}`);
  for (const p of r.profiles ?? []) lines.push(`  candidate: --harness ${p.harness}${p.model ? ` --model ${p.model}` : ''}${p.effort ? ` --effort ${p.effort}` : ''}`);
  if (r.latencyMs != null) lines.push(`  model: ${r.model}   latency_ms: ${r.latencyMs}   cost: $${r.cost}`);
  return lines.join('\n');
}

export const DEFAULT_SHADOW_LOG = new URL('../shadow.jsonl', import.meta.url).pathname;

const defaultIo = {
  readStdin: () => readFileSync(0, 'utf8'),
  exec: (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }),
  env: process.env,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  log: (line) => process.stdout.write(line + '\n'),
};

/** Run the CLI; returns { code, out }. */
export async function run(argv, { io = defaultIo, deps = {} } = {}) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (e) {
    return { code: 2, out: `error: ${e.message}\n\n${USAGE}` };
  }
  const { values: v, positionals } = parsed;
  const cmd = positionals[0];
  if (v.help || !cmd) return { code: v.help ? 0 : 2, out: USAGE };

  const here = dirname(fileURLToPath(import.meta.url));
  const key = (deps.loadKey ?? loadKey)('OPENROUTER_API_KEY', { env: io.env, files: [resolve(here, '../.env'), resolve(here, '../../../.env')] });
  try {
    if (cmd === 'triage') {
      let input;
      if (v.task) {
        input = readFirstmateTask(v['fm-home'] ?? io.env.FM_HOME ?? '../firstmate', v.task, io);
      } else {
        if (!v['pane-file']) throw new UsageError('triage needs --task <id> or --pane-file <f|->');
        input = {
          statusLine: v.status ?? '',
          pane: readText(v['pane-file'], io),
          brief: v['brief-file'] ? readText(v['brief-file'], io) : undefined,
        };
      }
      if (v['idle-seconds'] !== undefined) input.idleSeconds = Number(v['idle-seconds']);
      const r = await (deps.triageWake ?? triageWake)({ key, ...input });
      return { code: 0, out: v.json ? JSON.stringify(r, null, 2) : formatTriage(r) };
    }
    if (cmd === 'route') {
      if (!v['brief-file']) throw new UsageError('route needs --brief-file <f|->');
      const rulesPath = v.rules ?? join(io.env.FM_HOME ?? '../firstmate', 'config', 'crew-dispatch.json');
      const cfg = JSON.parse(readFileSync(rulesPath, 'utf8'));
      const r = await (deps.routeTask ?? routeTask)({ key, brief: readText(v['brief-file'], io), project: v.project ?? '', cfg });
      return { code: 0, out: v.json ? JSON.stringify(r, null, 2) : formatRoute(r) };
    }
    if (cmd === 'shadow') {
      const fmHome = v['fm-home'] ?? io.env.FM_HOME ?? '../firstmate';
      const logFile = v.log ?? DEFAULT_SHADOW_LOG;
      const triage = deps.triageWake ?? triageWake;
      const herdrState = v.herdr
        ? async (pane) => JSON.parse(io.exec('herdr', ['agent', 'get', pane])).result?.agent?.agent_status ?? 'no-agent'
        : null;
      const watcher = new ShadowWatcher({
        fmHome,
        logFile,
        herdrState,
        triageTask: async (taskId, wakeKind) => {
          const input = readFirstmateTask(fmHome, taskId, io);
          return { input, result: await triage({ key, ...input, wakeKind }) };
        },
      });
      watcher.primeFromDisk();
      const intervalMs = Number(v.interval ?? 3) * 1000;
      io.log(`shadowing ${fmHome} every ${intervalMs / 1000}s -> ${logFile}`);
      const polls = deps.maxPolls ?? Infinity;
      for (let i = 0; i < polls; i++) {
        for (const r of await watcher.poll()) {
          io.log(`${r.at} ${r.task} firstmate=${r.type === 'firstmate_woke' ? 'woke' : 'absorbed'} jev=${r.jev.action} (${r.jev.crewState ?? r.jev.source})`);
        }
        if (i + 1 < polls) await io.sleep(intervalMs);
      }
      return { code: 0, out: 'shadow stopped' };
    }
    if (cmd === 'shadow-report') {
      const logFile = v.log ?? DEFAULT_SHADOW_LOG;
      const records = existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
      const s = summarize(records);
      return { code: 0, out: v.json ? JSON.stringify(s, null, 2) : formatSummary(s) };
    }
    throw new UsageError(`unknown command "${cmd}"`);
  } catch (e) {
    return { code: 2, out: `error: ${e.message}${e instanceof UsageError ? `\n\n${USAGE}` : ''}` };
  }
}
