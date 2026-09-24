// Execution: run tasks in dependency order on their routed model, escalating one tier on failure.
import { execFileSync } from 'node:child_process';
import { runClaude } from './claude.mjs';
import { topoOrder } from './plan.mjs';
import { counterfactualUsd } from './cost.mjs';
import { taskRevOf } from './identity.mjs';

export const TASK_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['done', 'blocked', 'failed'], description: 'done = acceptance met; blocked = needs a human decision; failed = could not complete' },
    summary: { type: 'string' },
    files_changed: { type: 'array', items: { type: 'string' } },
    tests_run: { type: 'boolean' },
    tests_passed: { type: ['boolean', 'null'] },
    notes: { type: 'string' },
  },
  required: ['status', 'summary', 'files_changed', 'tests_run', 'tests_passed'],
  additionalProperties: false,
};

export function buildTaskPrompt(task, plan, depResults = []) {
  const deps = depResults.length
    ? ['Already completed by earlier tasks:', ...depResults.map((d) => `- ${d.id} ${d.title}: ${d.summary}`), '']
    : [];
  return [
    `Project: ${plan.summary ?? '(no summary)'}`,
    '',
    ...deps,
    `YOUR TASK (${task.id}): ${task.title}`,
    task.description,
    '',
    `Likely files: ${(task.files ?? []).join(', ') || 'not specified'}`,
    `Done when: ${task.acceptance ?? 'the task is complete'}`,
    '',
    'Do only this task. Run the relevant tests if the project has them. Do not commit or push.',
    'Do not edit existing tests to make them pass, and do not change files unrelated to this task. If something outside the task (for example an unrelated failing test) stops you, leave it alone and mention it in notes.',
    'Report status "blocked" (not "failed") if you need a human decision to continue.',
  ].join('\n');
}

/** Classify one attempt: done | blocked | failed, with the reason for anything but done. */
export function attemptOutcome(r) {
  if (!r.ok) return { status: 'failed', reason: `claude ${r.subtype ?? 'error'}` };
  const s = r.structured;
  if (!s || !['done', 'blocked', 'failed'].includes(s.status)) return { status: 'failed', reason: 'no structured result' };
  if (s.status === 'done' && s.tests_run && s.tests_passed === false) return { status: 'failed', reason: 'reported done but tests failed' };
  return { status: s.status, reason: s.status === 'done' ? null : s.notes || s.summary };
}

/** Files git reports as changed or untracked (null when not a git repo). */
export function gitChangedFiles(cwd, execImpl = execFileSync) {
  try {
    const out = execImpl('git', ['status', '--porcelain', '--untracked-files=all'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').filter(Boolean).map((l) => l.slice(3).replace(/^.* -> /, '')).filter((f) => !f.startsWith('.jev-router/'));
  } catch {
    return null;
  }
}

/** Files changed by this attempt that fall outside the task's declared files (prefix match allows directories). */
export function outOfScope(changed, before, taskFiles) {
  if (!changed || !taskFiles?.length) return [];
  const prior = new Set(before ?? []);
  const inScope = (f) => taskFiles.some((t) => f === t || f.startsWith(t.replace(/\/?$/, '/')));
  return changed.filter((f) => !prior.has(f) && !inScope(f));
}

export const nextTier = (tier, tiers) => tiers[tiers.indexOf(tier) + 1] ?? null;

/**
 * Run a routed plan. `only` limits to some task ids (their dependencies must already be done in `prior`).
 * Calls `onEvent` for progress and `record` for every attempt (the ledger).
 */
export async function runPlan({ routed, projectDir, config, runId, only = null, dryRun = false, prior = {}, runClaudeImpl = runClaude, changedFilesImpl = gitChangedFiles, onEvent = () => {}, record = () => {} }) {
  const results = { ...prior };
  for (const task of topoOrder(routed.tasks)) {
    if (only && !only.includes(task.id)) continue;
    const rev = taskRevOf(task);
    const done = results[task.id];
    if (done?.status === 'done' && (done.rev == null || done.rev === rev)) {
      onEvent({ type: 'already', task });
      continue;
    }
    if (done?.status === 'done') onEvent({ type: 'changed', task, reason: 'the task changed since it was done; running it again' });
    const blockers = (task.depends_on ?? []).filter((d) => results[d]?.status !== 'done');
    if (blockers.length) {
      results[task.id] = { id: task.id, title: task.title, status: 'skipped', reason: `waiting on ${blockers.join(', ')}` };
      onEvent({ type: 'skip', task, reason: results[task.id].reason });
      continue;
    }
    let tier = task.route?.tier ?? config.tiers.at(-1);
    if (dryRun) {
      results[task.id] = { id: task.id, title: task.title, status: 'done', summary: '(dry run)', tier, attempts: 0, costUsd: 0 };
      onEvent({ type: 'dry', task, tier });
      continue;
    }
    const depResults = (task.depends_on ?? []).map((d) => results[d]);
    const prompt = buildTaskPrompt(task, routed, depResults);
    const attempts = [];
    let outcome;
    for (let n = 1; n <= config.run.maxAttempts && tier; n++) {
      onEvent({ type: 'start', task, tier, attempt: n });
      const before = changedFilesImpl(projectDir);
      let r;
      try {
        r = await runClaudeImpl(
          prompt,
          { model: tier, schema: TASK_RESULT_SCHEMA, permissionMode: config.run.permissionMode, allowedTools: config.run.allowedTools, disallowedTools: config.run.disallowedTools, maxBudgetUsd: config.run.maxBudgetUsdPerAttempt },
          { cwd: projectDir, timeoutMs: config.run.timeoutMs },
        );
      } catch (e) {
        r = { ok: false, subtype: e.message, costUsd: 0, model: null };
      }
      outcome = attemptOutcome(r);
      const drift = outOfScope(changedFilesImpl(projectDir), before, task.files);
      const entry = { runId, planId: routed.planId ?? null, rev, outOfScope: drift, at: new Date().toISOString(), task: task.id, title: task.title, attempt: n, tier, model: r.model, status: outcome.status, reason: outcome.reason, costUsd: r.costUsd ?? 0, topModelCostUsd: counterfactualUsd(r.costUsd ?? 0, r.model ?? tier, config.tiers.at(-1)), numTurns: r.numTurns ?? null, durationMs: r.durationMs ?? null, permissionDenials: r.permissionDenials ?? 0, summary: r.structured?.summary ?? null, filesChanged: r.structured?.files_changed ?? [] };
      attempts.push(entry);
      record(entry);
      onEvent({ type: 'attempt', task, entry });
      if (outcome.status !== 'failed') break;
      const up = nextTier(tier, config.tiers);
      if (up && n < config.run.maxAttempts) onEvent({ type: 'escalate', task, from: tier, to: up, reason: outcome.reason });
      tier = up;
    }
    const last = attempts.at(-1);
    const drift = [...new Set(attempts.flatMap((a) => a.outOfScope))];
    results[task.id] = { id: task.id, title: task.title, rev, status: outcome.status, reason: outcome.reason, summary: last.summary, tier: last.tier, attempts: attempts.length, costUsd: attempts.reduce((s, a) => s + a.costUsd, 0), outOfScope: drift };
    if (drift.length) onEvent({ type: 'drift', task, files: drift });
  }
  return results;
}
