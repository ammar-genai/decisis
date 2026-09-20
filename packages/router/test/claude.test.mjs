import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildArgs, parseClaudeResult, runClaude } from '../src/claude.mjs';
import { fakeSpawn, claudeJson } from './helpers.mjs';

test('buildArgs includes only the options given', () => {
  assert.deepEqual(buildArgs({}), ['-p', '--output-format', 'json']);
  const a = buildArgs({ model: 'haiku', schema: { type: 'object' }, permissionMode: 'acceptEdits', allowedTools: ['Read', 'Edit'], disallowedTools: ['Bash'], maxBudgetUsd: 1.5, appendSystemPrompt: 'be brief' });
  assert.deepEqual(a, ['-p', '--output-format', 'json', '--model', 'haiku', '--json-schema', '{"type":"object"}', '--permission-mode', 'acceptEdits', '--allowedTools', 'Read,Edit', '--disallowedTools', 'Bash', '--max-budget-usd', '1.5', '--append-system-prompt', 'be brief']);
});

test('parseClaudeResult normalises success and error results', () => {
  const ok = parseClaudeResult(claudeJson({ structured_output: { a: 1 }, permission_denials: [{}, {}] }));
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.structured, { a: 1 });
  assert.equal(ok.model, 'claude-sonnet-5');
  assert.equal(ok.permissionDenials, 2);
  const bad = parseClaudeResult({ is_error: true, subtype: 'error_max_budget_usd' });
  assert.equal(bad.ok, false);
  assert.equal(bad.model, null);
  assert.equal(bad.costUsd, 0);
  assert.equal(bad.structured, null);
  assert.equal(parseClaudeResult({ modelUsage: { 'claude-x': {} } }).model, 'claude-x');
});

test('runClaude sends the prompt on stdin and parses JSON', async () => {
  const sp = fakeSpawn({ stdout: JSON.stringify(claudeJson()) });
  const r = await runClaude('do it', { model: 'opus' }, { cwd: '/p', spawnImpl: sp });
  assert.equal(r.ok, true);
  assert.equal(sp.calls[0].bin, 'claude');
  assert.equal(sp.calls[0].stdin, 'do it');
  assert.equal(sp.calls[0].opts.cwd, '/p');
  assert.ok(sp.calls[0].args.includes('opus'));
});

test('runClaude rejects on non-JSON output, spawn errors and timeouts', async () => {
  await assert.rejects(runClaude('x', {}, { spawnImpl: fakeSpawn({ stdout: 'oops', code: 1 }) }), /exited 1 without JSON output: oops/);
  await assert.rejects(runClaude('x', {}, { spawnImpl: fakeSpawn({ stderr: 'bad flag', code: 2 }) }), /bad flag/);
  await assert.rejects(runClaude('x', {}, { spawnImpl: fakeSpawn({ error: new Error('ENOENT') }) }), /could not start claude: ENOENT/);
  await assert.rejects(runClaude('x', {}, { spawnImpl: fakeSpawn({ hang: true }), timeoutMs: 10 }), /timed out/);
});
