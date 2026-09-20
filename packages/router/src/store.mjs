// Everything the router writes lives in <project>/.jev-router/.
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const stateDir = (projectDir) => join(projectDir, '.jev-router');
export const planPath = (projectDir) => join(stateDir(projectDir), 'plan.json');
export const routedPath = (projectDir) => join(stateDir(projectDir), 'routed.json');
export const ledgerPath = (projectDir) => join(stateDir(projectDir), 'ledger.jsonl');

export function writeJson(file, data) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

export function readJson(file, what) {
  if (!existsSync(file)) throw new Error(`no ${what} yet (${file}); run the earlier step first`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function appendLedger(projectDir, entry) {
  mkdirSync(stateDir(projectDir), { recursive: true });
  appendFileSync(ledgerPath(projectDir), JSON.stringify(entry) + '\n');
}

export function readLedger(projectDir) {
  const f = ledgerPath(projectDir);
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}
