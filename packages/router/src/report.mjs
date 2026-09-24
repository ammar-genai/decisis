// Summaries over the ledger (every attempt ever run in this project).

/**
 * Latest outcome per task across all runs (a later run can finish what an earlier one left).
 * Scoped to one plan: the ledger spans every plan ever run in this project, and task ids repeat.
 */
export function latestByTask(ledger, planId = null) {
  const out = {};
  for (const e of ledger) {
    if (planId !== null && e.planId !== planId) continue;
    out[e.task] = e;
  }
  return out;
}

/**
 * Tasks already done, in the shape runPlan() accepts as `prior`.
 *
 * Pass the current `planId`. Entries from another plan, and older entries written before plans had
 * ids, are ignored - re-running a task costs money, but silently skipping real work costs more.
 * Each record carries the task `rev` it was done at, so an edited task is not counted as done.
 */
export function priorDone(ledger, planId = null) {
  return Object.fromEntries(
    Object.values(latestByTask(ledger, planId))
      .filter((e) => e.status === 'done')
      .map((e) => [e.task, { id: e.task, title: e.title, status: 'done', summary: e.summary, tier: e.tier, rev: e.rev ?? null }]),
  );
}

export function summarize(ledger, tiers) {
  const byTier = Object.fromEntries(tiers.map((t) => [t, { attempts: 0, costUsd: 0 }]));
  let cost = 0;
  let top = 0;
  let topKnown = true;
  for (const e of ledger) {
    byTier[e.tier] ??= { attempts: 0, costUsd: 0 };
    byTier[e.tier].attempts++;
    byTier[e.tier].costUsd += e.costUsd;
    cost += e.costUsd;
    if (e.topModelCostUsd == null) topKnown = false;
    else top += e.topModelCostUsd;
  }
  const latest = Object.values(latestByTask(ledger));
  const escalations = ledger.filter((e) => e.attempt > 1).length;
  return {
    attempts: ledger.length,
    tasks: latest.length,
    statuses: latest.reduce((m, e) => ({ ...m, [e.status]: (m[e.status] ?? 0) + 1 }), {}),
    escalations,
    costUsd: cost,
    topModelCostUsd: topKnown ? top : null,
    byTier,
    latest,
  };
}

const usd = (x) => (x == null ? 'n/a' : `$${x.toFixed(4)}`);

export function formatSummary(s, tiers) {
  const lines = [
    `tasks: ${s.tasks}  ${Object.entries(s.statuses).map(([k, v]) => `${k}=${v}`).join(' ')}   attempts: ${s.attempts}   escalations: ${s.escalations}`,
    `cost: ${usd(s.costUsd)}   same tokens all on ${tiers.at(-1)} (rough): ${usd(s.topModelCostUsd)}${s.topModelCostUsd ? `   saved ≈ ${Math.round((1 - s.costUsd / s.topModelCostUsd) * 100)}%` : ''}`,
    `by tier: ${Object.entries(s.byTier).map(([t, v]) => `${t} ${v.attempts}× ${usd(v.costUsd)}`).join('   ')}`,
    '',
  ];
  for (const e of s.latest) lines.push(`${e.status.padEnd(8)} ${e.task.padEnd(5)} ${e.tier.padEnd(7)} ${usd(e.costUsd).padEnd(9)} ${e.title}${e.reason ? `  (${e.reason})` : ''}${e.outOfScope?.length ? `  [REVIEW: out of scope ${e.outOfScope.join(', ')}]` : ''}`);
  return lines.join('\n');
}
