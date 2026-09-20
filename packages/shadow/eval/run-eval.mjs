// Run the labelled triage + routing sets against live Jev and report accuracy, the dangerous
// error (missed wakes), wakes saved, latency and cost.
// Usage: node eval/run-eval.mjs [--runs N] [--only triage|route] [--verbose]
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadKey } from '../src/key.mjs';
import { triageWake } from '../src/triage.mjs';
import { routeTask } from '../src/route.mjs';
import triageCases from './triage-cases.mjs';
import routeCases from './route-cases.mjs';
import cfg from './sample-crew-dispatch.json' with { type: 'json' };

const { values: v } = parseArgs({ options: { runs: { type: 'string' }, only: { type: 'string' }, verbose: { type: 'boolean' } } });
const RUNS = Number(v.runs ?? 1);
const key = loadKey();
if (!key) {
  console.error('No OPENROUTER_API_KEY found.');
  process.exit(1);
}

const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(0)}%` : 'n/a');
const quantile = (xs, q) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(q * xs.length))];
const results = { at: new Date().toISOString(), runs: RUNS };

if (v.only !== 'route') {
  const rows = [];
  for (let run = 1; run <= RUNS; run++) {
    const out = await Promise.all(triageCases.map((c) => triageWake({ key, taskId: c.id, ...c })));
    out.forEach((r, i) => rows.push({ run, case: triageCases[i], r }));
  }
  const ok = rows.filter(({ case: c, r }) => r.action === c.expect.action);
  const stateOk = rows.filter(({ case: c, r }) => c.expect.states.includes(r.crewState));
  const missed = rows.filter(({ case: c, r }) => c.expect.action === 'wake' && r.action === 'absorb');
  const extra = rows.filter(({ case: c, r }) => c.expect.action === 'absorb' && r.action === 'wake');
  const absorbable = rows.filter(({ case: c }) => c.expect.action === 'absorb');
  const lat = rows.map(({ r }) => r.latencyMs).filter(Number.isFinite);
  const cost = rows.reduce((s, { r }) => s + (r.cost ?? 0), 0);
  const errors = rows.filter(({ r }) => r.source === 'error');

  console.log(`\n=== Wake triage: ${triageCases.length} cases x ${RUNS} run(s) ===`);
  for (const { run, case: c, r } of rows) {
    const mark = r.action === c.expect.action ? (c.expect.states.includes(r.crewState) ? '✓' : '~') : c.expect.action === 'wake' ? '✗ MISSED WAKE' : '✗ extra wake';
    if (v.verbose || mark !== '✓' || RUNS === 1)
      console.log(`${mark.padEnd(14)} ${`[${run}] ${c.id}`.padEnd(32)} ${r.action.padEnd(6)} ${String(r.crewState).padEnd(17)} conf=${r.confidence ?? '-'} need=${r.needsSupervisor ?? '-'} loop=${r.looping ?? '-'} ${r.latencyMs ?? '-'}ms`);
  }
  console.log(`\naction accuracy:     ${ok.length}/${rows.length} (${pct(ok.length, rows.length)})`);
  console.log(`crew_state accuracy: ${stateOk.length}/${rows.length} (${pct(stateOk.length, rows.length)})`);
  console.log(`missed wakes (bad):  ${missed.length}   extra wakes (cost only): ${extra.length}   api errors: ${errors.length}`);
  console.log(`wakes saved vs "no working evidence -> wake": ${absorbable.length - extra.length}/${absorbable.length}`);
  console.log(`latency ms: p50 ${quantile(lat, 0.5)}  p95 ${quantile(lat, 0.95)}  max ${Math.max(...lat)}   total cost $${cost.toFixed(6)}`);
  results.triage = { accuracy: ok.length / rows.length, stateAccuracy: stateOk.length / rows.length, missed: missed.length, extra: extra.length, errors: errors.length, p50: quantile(lat, 0.5), p95: quantile(lat, 0.95), cost,
    rows: rows.map(({ run, case: c, r }) => ({ run, id: c.id, expect: c.expect, action: r.action, crewState: r.crewState, confidence: r.confidence, needsSupervisor: r.needsSupervisor, looping: r.looping, latencyMs: r.latencyMs, reason: r.reason })) };
}

if (v.only !== 'triage') {
  const rows = [];
  for (let run = 1; run <= RUNS; run++) {
    const out = await Promise.all(routeCases.map((c) => routeTask({ key, brief: c.brief, cfg })));
    out.forEach((r, i) => rows.push({ run, case: routeCases[i], r }));
  }
  const ok = rows.filter(({ case: c, r }) => c.expect.includes(r.rule));
  const lat = rows.map(({ r }) => r.latencyMs).filter(Number.isFinite);
  console.log(`\n=== Dispatch routing: ${routeCases.length} briefs x ${RUNS} run(s) ===`);
  for (const { run, case: c, r } of rows) {
    const mark = c.expect.includes(r.rule) ? '✓' : '✗';
    if (v.verbose || mark !== '✓' || RUNS === 1)
      console.log(`${mark} ${`[${run}] ${c.id}`.padEnd(22)} ${String(r.rule).padEnd(8)} (want ${c.expect.join('|')})  status=${r.status.padEnd(9)} conf=${r.confidence} ${r.latencyMs ?? '-'}ms`);
  }
  console.log(`\nrule accuracy: ${ok.length}/${rows.length} (${pct(ok.length, rows.length)})   clear: ${rows.filter(({ r }) => r.status === 'clear').length}   escalate: ${rows.filter(({ r }) => r.status === 'escalate').length}   ambiguous: ${rows.filter(({ r }) => r.status === 'ambiguous').length}   error: ${rows.filter(({ r }) => r.status === 'error').length}`);
  console.log(`latency ms: p50 ${quantile(lat, 0.5)}  p95 ${quantile(lat, 0.95)}`);
  results.route = { accuracy: ok.length / rows.length, rows: rows.map(({ run, case: c, r }) => ({ run, id: c.id, expect: c.expect, rule: r.rule, status: r.status, confidence: r.confidence, latencyMs: r.latencyMs })) };
}

const file = new URL(`./results-${results.at.replace(/[:.]/g, '-')}.json`, import.meta.url);
writeFileSync(file, JSON.stringify(results, null, 2));
console.log(`\nresults written to eval/${file.pathname.split('/').at(-1)}`);
