import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlannerPrompt, validatePlan, topoOrder, makePlan, PLAN_SCHEMA } from '../src/plan.mjs';
import { DEFAULT_CONFIG } from '../src/config.mjs';

const t = (id, deps = []) => ({ id, title: id, description: id, files: [], depends_on: deps, acceptance: 'x' });

test('planner prompt carries the goal and schema requires the task fields', () => {
  assert.match(buildPlannerPrompt('ship it'), /GOAL: ship it/);
  assert.deepEqual(PLAN_SCHEMA.properties.tasks.items.required, ['id', 'title', 'description', 'files', 'depends_on', 'acceptance']);
});

test('topoOrder respects dependencies and is stable', () => {
  assert.deepEqual(topoOrder([t('a', ['c']), t('b'), t('c', ['b'])]).map((x) => x.id), ['b', 'c', 'a']);
  assert.deepEqual(topoOrder([{ id: 'x' }, { id: 'y' }]).map((x) => x.id), ['x', 'y']);
  assert.throws(() => topoOrder([t('a', ['b']), t('b', ['a'])]), /cycle among tasks: a, b/);
});

test('validatePlan catches empty plans, duplicate ids and unknown deps', () => {
  assert.throws(() => validatePlan(null), /no tasks/);
  assert.throws(() => validatePlan({ tasks: [] }), /no tasks/);
  assert.throws(() => validatePlan({ tasks: [t('a'), t('a')] }), /duplicate/);
  assert.throws(() => validatePlan({ tasks: [{ title: 'no id' }] }), /missing task id/);
  assert.throws(() => validatePlan({ tasks: [t('a', ['zz'])] }), /unknown task zz/);
  assert.doesNotThrow(() => validatePlan({ tasks: [t('a'), { ...t('b'), depends_on: undefined }] }));
});

test('makePlan runs the planner read-only with the schema and stamps metadata', async () => {
  let seen;
  const fake = async (prompt, opts, ctx) => {
    seen = { prompt, opts, ctx };
    return { ok: true, structured: { summary: 's', tasks: [t('t1')] }, model: 'claude-opus-5', costUsd: 0.4, durationMs: 9 };
  };
  const plan = await makePlan({ goal: 'g', projectDir: '/proj', config: DEFAULT_CONFIG, runClaudeImpl: fake });
  assert.equal(plan.goal, 'g');
  assert.equal(plan.planner.model, 'claude-opus-5');
  assert.equal(plan.tasks.length, 1);
  assert.equal(seen.opts.model, 'opus');
  assert.deepEqual(seen.opts.disallowedTools, ['Edit', 'Write', 'NotebookEdit', 'Bash']);
  assert.equal(seen.opts.schema, PLAN_SCHEMA);
  assert.equal(seen.ctx.cwd, '/proj');
});

test('makePlan fails loudly when the planner fails or returns nothing structured', async () => {
  await assert.rejects(makePlan({ goal: 'g', projectDir: '.', config: DEFAULT_CONFIG, runClaudeImpl: async () => ({ ok: false, subtype: 'error_max_budget_usd', result: 'x' }) }), /planner failed \(error_max_budget_usd\)/);
  await assert.rejects(makePlan({ goal: 'g', projectDir: '.', config: DEFAULT_CONFIG, runClaudeImpl: async () => ({ ok: true, structured: null }) }), /planner failed/);
});
