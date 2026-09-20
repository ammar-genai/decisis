// Defaults, overridable per project with jev-router.config.json in the project root.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const CONFIG_FILE = 'jev-router.config.json';

export const DEFAULT_CONFIG = {
  // Cheapest -> strongest. Values are passed to `claude --model` (aliases resolve to the latest model).
  tiers: ['haiku', 'sonnet', 'opus'],
  planner: {
    model: 'opus',
    maxBudgetUsd: 3,
    // Read-only: the planner can look at the project but not change it.
    allowedTools: ['Read', 'Glob', 'Grep'],
    disallowedTools: ['Edit', 'Write', 'NotebookEdit', 'Bash'],
  },
  jev: { model: 'typesafe/jev-1.13' },
  policy: {
    confidenceFloor: 0.6, // below this, Jev's pick is bumped one tier up
    riskFloor: { High: 'opus', Medium: 'sonnet' },
    ambiguityThreshold: 0.6, // P(needs design decisions) above this => at least `ambiguityFloor`
    ambiguityFloor: 'sonnet',
    complexityFloor: { 'Very hard': 'opus' },
  },
  run: {
    permissionMode: 'acceptEdits',
    allowedTools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash(npm test*)', 'Bash(npm run *)', 'Bash(node --test*)', 'Bash(git status*)', 'Bash(git diff*)'],
    disallowedTools: ['Bash(git push*)', 'Bash(git commit*)', 'Bash(rm -rf*)'],
    maxBudgetUsdPerAttempt: 2,
    maxAttempts: 2, // 2 = one escalation to the next tier on failure
    timeoutMs: 20 * 60 * 1000,
  },
};

const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);

export function mergeConfig(base, over) {
  if (!isObj(over)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base[k]) ? mergeConfig(base[k], v) : v;
  return out;
}

export function validateConfig(cfg) {
  if (!Array.isArray(cfg.tiers) || cfg.tiers.length < 2) throw new Error('config.tiers needs at least two models, cheapest first');
  const known = new Set(cfg.tiers);
  const floors = [...Object.values(cfg.policy.riskFloor ?? {}), ...Object.values(cfg.policy.complexityFloor ?? {}), cfg.policy.ambiguityFloor];
  for (const t of floors) if (t != null && !known.has(t)) throw new Error(`policy floor "${t}" is not one of tiers ${cfg.tiers.join(', ')}`);
  if (!(cfg.run.maxAttempts >= 1)) throw new Error('run.maxAttempts must be >= 1');
  return cfg;
}

export function loadConfig(projectDir) {
  const f = join(projectDir, CONFIG_FILE);
  const over = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {};
  return validateConfig(mergeConfig(DEFAULT_CONFIG, over));
}
