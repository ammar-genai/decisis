import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CONFIG, mergeConfig, validateConfig, loadConfig, CONFIG_FILE } from '../src/config.mjs';
import { tmp } from './helpers.mjs';

test('mergeConfig deep-merges objects and replaces arrays', () => {
  const m = mergeConfig(DEFAULT_CONFIG, { tiers: ['haiku', 'opus'], policy: { confidenceFloor: 0.8 }, run: 'x' === 'y' ? {} : { maxAttempts: 3 } });
  assert.deepEqual(m.tiers, ['haiku', 'opus']);
  assert.equal(m.policy.confidenceFloor, 0.8);
  assert.equal(m.policy.ambiguityFloor, 'sonnet');
  assert.equal(m.run.maxAttempts, 3);
  assert.equal(mergeConfig(DEFAULT_CONFIG, null), DEFAULT_CONFIG);
});

test('validateConfig rejects bad tiers, unknown floors and zero attempts', () => {
  assert.throws(() => validateConfig({ ...DEFAULT_CONFIG, tiers: ['opus'] }), /at least two/);
  assert.throws(() => validateConfig(mergeConfig(DEFAULT_CONFIG, { policy: { riskFloor: { High: 'gpt' } } })), /"gpt" is not one of tiers/);
  assert.throws(() => validateConfig(mergeConfig(DEFAULT_CONFIG, { run: { maxAttempts: 0 } })), /maxAttempts/);
  assert.doesNotThrow(() => validateConfig(mergeConfig(DEFAULT_CONFIG, { policy: { ambiguityFloor: null } })));
});

test('loadConfig reads the project file when present', () => {
  const d = tmp();
  assert.equal(loadConfig(d).planner.model, 'opus');
  writeFileSync(join(d, CONFIG_FILE), JSON.stringify({ planner: { model: 'fable' } }));
  assert.equal(loadConfig(d).planner.model, 'fable');
});
