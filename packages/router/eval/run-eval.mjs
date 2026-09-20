// Live routing eval: how often does Jev (+ policy) pick an acceptable tier, and how often does it
// under-route (weaker model than needed)? Costs ~$0.001 per run. Usage: node eval/run-eval.mjs [--runs N] [--verbose]
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadKey } from '../src/key.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';
import { routeTask } from '../src/route.mjs';
import cases, { PROJECT } from './tasks.mjs';

const { values: v } = parseArgs({ options: { runs: { type: 'string' }, verbose: { type: 'boolean' } } });
const RUNS = Number(v.runs ?? 1);
const key = loadKey();
if (!key) {
  console.error('No OPENROUTER_API_KEY found.');
  process.exit(1);
}
const tiers = DEFAULT_CONFIG.tiers;
const rank = (t) => tiers.indexOf(t);
const PRICE = { haiku: 1, sonnet: 2, opus: 5 };

function grade(tier, c) {
  const lo = Math.min(...c.ok.map(rank));
  const hi = Math.max(...c.ok.map(rank));
  return rank(tier) < lo ? 'UNDER' : rank(tier) > hi ? 'over' : 'ok';
}

const rows = [];
for (let run = 1; run <= RUNS; run++) {
  const out = await Promise.all(cases.map((c) => routeTask({ key, task: c.task, plan: PROJECT, config: DEFAULT_CONFIG })));
  out.forEach((r, i) => rows.push({ run, c: cases[i], r }));
}

const tally = (pick) => {
  const g = rows.map(({ c, r }) => grade(pick(r), c));
  return { ok: g.filter((x) => x === 'ok').length, under: g.filter((x) => x === 'UNDER').length, over: g.filter((x) => x === 'over').length, ideal: rows.filter(({ c, r }) => pick(r) === c.ideal).length };
};
const jev = tally((r) => r.jevTier ?? r.tier);
const fin = tally((r) => r.tier);
const cost = (pick) => rows.reduce((s, { r }) => s + PRICE[pick(r)], 0);

console.log(`\n=== Routing eval: ${cases.length} tasks x ${RUNS} run(s) ===`);
for (const { run, c, r } of rows) {
  const g = grade(r.tier, c);
  if (v.verbose || g !== 'ok' || RUNS === 1)
    console.log(`${g.padEnd(6)} ${`[${run}] ${c.id}`.padEnd(16)} final=${r.tier.padEnd(7)} jev=${String(r.jevTier).padEnd(7)} ideal=${c.ideal.padEnd(7)} conf=${r.confidence} cx=${r.complexity} risk=${r.risk} amb=${r.ambiguity}${r.raised ? '  raised: ' + r.reasons.slice(1).join('; ') : ''}`);
}
const n = rows.length;
console.log(`\n                 acceptable   ideal     UNDER-routed   over-routed`);
console.log(`Jev pick alone   ${`${jev.ok}/${n}`.padEnd(12)} ${`${jev.ideal}/${n}`.padEnd(9)} ${String(jev.under).padEnd(14)} ${jev.over}`);
console.log(`Jev + policy     ${`${fin.ok}/${n}`.padEnd(12)} ${`${fin.ideal}/${n}`.padEnd(9)} ${String(fin.under).padEnd(14)} ${fin.over}`);
const allTop = n * PRICE.opus;
console.log(`\nrelative model cost (input-price units): all-opus ${allTop}, ideal labels ${cost((r) => rows.find((x) => x.r === r).c.ideal)}, Jev+policy ${cost((r) => r.tier)}  -> ${Math.round((1 - cost((r) => r.tier) / allTop) * 100)}% cheaper than all-opus`);
const lat = rows.map(({ r }) => r.latencyMs).filter(Number.isFinite).sort((a, b) => a - b);
const jevCost = rows.reduce((s, { r }) => s + (r.jevCostUsd ?? 0), 0);
console.log(`jev latency p50 ${lat[Math.floor(lat.length / 2)]} ms, total jev cost $${jevCost.toFixed(5)}, fallbacks ${rows.filter(({ r }) => r.source === 'fallback').length}`);

const file = new URL(`./results-${new Date().toISOString().replace(/[:.]/g, '-')}.json`, import.meta.url);
writeFileSync(file, JSON.stringify({ runs: RUNS, jev, final: fin, rows: rows.map(({ run, c, r }) => ({ run, id: c.id, ideal: c.ideal, ok: c.ok, ...r })) }, null, 2));
