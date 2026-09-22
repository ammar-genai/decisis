import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { claudeCodeDecider, claudeCodeArgs, DecisionError } from '../src/index.ts';
import { QUESTIONS } from './helpers.ts';

/** A fake child_process.spawn that replays stdout and an exit code, recording args and stdin. */
function fakeSpawn({ stdout = '', stderr = '', code = 0, error = null as Error | null, hang = false } = {}) {
  const calls: { bin: string; args: string[]; stdin: string }[] = [];
  const fn = ((bin: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), killed: false }) as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; stdin: { end: (s: string) => void }; kill: () => void; killed: boolean };
    const call = { bin, args, stdin: '' };
    child.stdin = { end: (s: string) => (call.stdin = s) };
    child.kill = () => (child.killed = true);
    calls.push(call);
    if (!hang) setImmediate(() => {
      if (error) return child.emit('error', error);
      if (stdout) child.stdout.emit('data', stdout);
      if (stderr) child.stderr.emit('data', stderr);
      child.emit('close', code);
    });
    return child;
  }) as unknown as typeof import('node:child_process').spawn & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

const GOOD = { urgent: { probability: 0.4 }, tier: { choice: 'medium', confidence: 0.8 }, risk: { level: 'High', confidence: 0.6 } };
const cli = (over: Record<string, unknown> = {}) => JSON.stringify({ subtype: 'success', is_error: false, structured_output: GOOD, duration_ms: 2100, total_cost_usd: 0.03, modelUsage: { 'claude-haiku-4-5-20251001': { canonicalModel: 'claude-haiku-4-5' } }, ...over });

test('claudeCodeArgs asks for JSON matching the questions, read-only, in a bounded turn', () => {
  const args = claudeCodeArgs('haiku', QUESTIONS);
  assert.deepEqual(args.slice(0, 5), ['-p', '--model', 'haiku', '--output-format', 'json']);
  assert.ok(args.includes('--restricted'));
  assert.deepEqual(JSON.parse(args[args.indexOf('--json-schema') + 1]).required, ['urgent', 'tier', 'risk']);
});

test('claudeCodeDecider runs the CLI, sends the state on stdin and maps the answers', async () => {
  const sp = fakeSpawn({ stdout: cli() });
  const r = await claudeCodeDecider({ spawnImpl: sp })({ task: 'x' }, QUESTIONS);
  assert.equal(sp.calls[0].bin, 'claude');
  assert.match(sp.calls[0].stdin, /State:\n\{\n "task": "x"\n\}/);
  assert.equal(r.answers.tier.type === 'choice' && r.answers.tier.choice, 'medium');
  assert.equal(r.answers.risk.type === 'score' && r.answers.risk.score, 2);
  assert.equal(r.model, 'claude-haiku-4-5');
  assert.equal(r.costUsd, null);
  assert.equal(r.listPriceUsd, 0.03);
  assert.equal(r.cliDurationMs, 2100);
  const plain = await claudeCodeDecider({ spawnImpl: fakeSpawn({ stdout: cli({ modelUsage: undefined, total_cost_usd: undefined, duration_ms: undefined }) }), model: 'sonnet' })('text state', QUESTIONS);
  assert.equal(plain.model, 'sonnet');
  assert.equal(plain.listPriceUsd, null);
  assert.match(fakeSpawn().calls.length.toString(), /0/);
});

test('claudeCodeDecider turns CLI failures into DecisionErrors', async () => {
  const run = (o: Parameters<typeof fakeSpawn>[0]) => claudeCodeDecider({ spawnImpl: fakeSpawn(o), timeoutMs: 20 })('s', QUESTIONS);
  await assert.rejects(run({ stdout: 'not json', code: 1, stderr: 'bad flag' }), /exited 1 without JSON output: bad flag/);
  await assert.rejects(run({ stdout: cli({ is_error: true, subtype: 'error_max_budget_usd', result: 'over budget' }) }), /claude error_max_budget_usd: over budget/);
  await assert.rejects(run({ stdout: cli({ structured_output: undefined }) }), /no structured output/);
  await assert.rejects(run({ stdout: cli({ structured_output: { ...GOOD, tier: { choice: 'gigantic', confidence: 1 } } }) }), (e) => e instanceof DecisionError && /"tier" is malformed/.test(e.message));
  await assert.rejects(run({ error: new Error('ENOENT') }), /could not start claude: ENOENT/);
  await assert.rejects(run({ hang: true }), /timed out/);
});
