// CLI logic, kept apart from bin/ so tests can drive it.
import { parseArgs } from 'node:util';
import { dirname, resolve } from 'node:path';
import { loadKey } from '@decisis/core';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';
import { makePlan } from './plan.mjs';
import { routePlan, routeTask } from './route.mjs';
import { runPlan } from './run.mjs';
import { summarize, formatSummary, priorDone } from './report.mjs';
import { planPath, routedPath, writeJson, readJson, appendLedger, readLedger } from './store.mjs';

export const USAGE = `decisis-router - a top model plans, a fast model routes each task to a model tier, Claude Code runs them

Usage (run inside your project, or pass --project <dir>):
  decisis-router plan "<goal>"        top model reads the repo (read-only) and writes .jev-router/plan.json
  decisis-router route                Jev picks haiku|sonnet|opus per task -> .jev-router/routed.json
  decisis-router run [--dry-run] [--only t1,t3]
                                  run tasks in dependency order with claude -p --model <tier>;
                                  a failed task escalates one tier; done tasks are skipped on re-run
  decisis-router report               cost by tier, escalations, rough all-on-top-model comparison
  decisis-router classify "<task>"    route one ad-hoc task description (no plan needed)

Options: --project <dir>  --json
Config: <project>/jev-router.config.json (tiers, planner, policy, run). Key: OPENROUTER_API_KEY.
`;

const OPTIONS = {
  project: { type: 'string' },
  only: { type: 'string' },
  'dry-run': { type: 'boolean' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

export class UsageError extends Error {}

const pad = (s, n) => String(s).padEnd(n);

export function formatRouted(routed) {
  const summary = (routed.summary ?? '').split(/(?<=\.)\s/)[0].slice(0, 160);
  const lines = [`${routed.tasks.length} tasks   ${summary}`.trim(), ''];
  for (const t of routed.tasks) {
    const r = t.route;
    const deps = t.depends_on?.length ? ` <- ${t.depends_on.join(',')}` : '';
    lines.push(`${pad(t.id, 5)} ${pad(r.tier, 7)} ${t.title}${deps}`);
    lines.push(`      ${r.reasons.join('; ')}${r.complexity ? `   [complexity ${r.complexity}, risk ${r.risk}, ambiguity ${r.ambiguity}]` : ''}`);
  }
  const counts = routed.tasks.reduce((m, t) => ({ ...m, [t.route.tier]: (m[t.route.tier] ?? 0) + 1 }), {});
  lines.push('', `mix: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  return lines.join('\n');
}

export async function run(argv, { deps = {}, log = () => {} } = {}) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (e) {
    return { code: 2, out: `error: ${e.message}\n\n${USAGE}` };
  }
  const { values: v, positionals } = parsed;
  const [cmd, ...rest] = positionals;
  if (v.help || !cmd) return { code: v.help ? 0 : 2, out: USAGE };
  const projectDir = resolve(v.project ?? process.cwd());
  const out = (data, text) => ({ code: 0, out: v.json ? JSON.stringify(data, null, 2) : text });

  try {
    const config = loadConfig(projectDir);
    const key = () => {
      const here = dirname(fileURLToPath(import.meta.url));
      const k = (deps.loadKey ?? loadKey)('OPENROUTER_API_KEY', { files: [resolve(here, '../.env'), resolve(here, '../../../.env')] });
      if (!k) throw new UsageError('no OPENROUTER_API_KEY (environment or .env)');
      return k;
    };
    if (cmd === 'plan') {
      const goal = rest.join(' ').trim();
      if (!goal) throw new UsageError('plan needs a goal');
      log(`planning with ${config.planner.model} (read-only)...`);
      const plan = await makePlan({ goal, projectDir, config, runClaudeImpl: deps.runClaude });
      writeJson(planPath(projectDir), plan);
      const text = [`plan: ${plan.tasks.length} tasks  (planner ${plan.planner.model}, $${plan.planner.costUsd.toFixed(4)})`, plan.summary, '', ...plan.tasks.map((t) => `${pad(t.id, 5)} ${t.title}${t.depends_on.length ? ` <- ${t.depends_on.join(',')}` : ''}`), '', `next: decisis-router route`].join('\n');
      return out(plan, text);
    }
    if (cmd === 'route') {
      const plan = readJson(planPath(projectDir), 'plan');
      const routed = await routePlan({ key: key(), plan, config, decideImpl: deps.decide });
      writeJson(routedPath(projectDir), routed);
      return out(routed, `${formatRouted(routed)}\n\nnext: review .jev-router/routed.json (edit any route.tier you disagree with), then decisis-router run`);
    }
    if (cmd === 'classify') {
      const text = rest.join(' ').trim();
      if (!text) throw new UsageError('classify needs a task description');
      const r = await routeTask({ key: key(), task: { title: text, description: text, files: [], depends_on: [] }, plan: {}, config, decideImpl: deps.decide });
      return out(r, `${r.tier}\n  ${r.reasons.join('; ')}${r.complexity ? `\n  complexity ${r.complexity}, risk ${r.risk}, ambiguity ${r.ambiguity}` : ''}`);
    }
    if (cmd === 'run') {
      const routed = readJson(routedPath(projectDir), 'routed plan');
      const runId = new Date().toISOString();
      const only = v.only ? v.only.split(',').map((s) => s.trim()) : null;
      const dryRun = !!v['dry-run'];
      const results = await runPlan({
        routed, projectDir, config, runId, only, dryRun,
        prior: dryRun ? {} : priorDone(readLedger(projectDir)),
        runClaudeImpl: deps.runClaude,
        record: (e) => appendLedger(projectDir, e),
        onEvent: (e) => {
          if (e.type === 'start') log(`${e.task.id} ${e.tier} (attempt ${e.attempt}): ${e.task.title}`);
          if (e.type === 'attempt') log(`   -> ${e.entry.status} $${e.entry.costUsd.toFixed(4)}${e.entry.reason ? ` (${e.entry.reason})` : ''}`);
          if (e.type === 'escalate') log(`   escalating ${e.from} -> ${e.to}`);
          if (e.type === 'skip') log(`${e.task.id} skipped: ${e.reason}`);
          if (e.type === 'drift') log(`   ! needs review: ${e.task.id} changed files outside its scope: ${e.files.join(', ')}`);
          if (e.type === 'already') log(`${e.task.id} already done in an earlier run`);
          if (e.type === 'dry') log(`${e.task.id} would run on ${e.tier}: ${e.task.title}`);
        },
      });
      const lines = Object.values(results).map((r) => `${pad(r.status, 8)} ${pad(r.id, 5)} ${pad(r.tier ?? '-', 7)} ${r.title}${r.reason ? `  (${r.reason})` : ''}${r.outOfScope?.length ? `  [REVIEW: out of scope ${r.outOfScope.join(', ')}]` : ''}`);
      return out(results, `${dryRun ? 'dry run - nothing executed\n' : ''}${lines.join('\n')}${dryRun ? '' : '\n\nnext: decisis-router report, and review the diff'}`);
    }
    if (cmd === 'report') {
      const s = summarize(readLedger(projectDir), config.tiers);
      return out(s, formatSummary(s, config.tiers));
    }
    throw new UsageError(`unknown command "${cmd}"`);
  } catch (e) {
    return { code: 2, out: `error: ${e.message}${e instanceof UsageError ? `\n\n${USAGE}` : ''}` };
  }
}
