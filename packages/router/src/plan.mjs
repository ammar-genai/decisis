// Planning: the top model reads the project (read-only) and breaks a goal into routed-ready tasks.
import { runClaude } from './claude.mjs';

export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'One paragraph: what the project is and how the goal will be achieved.' },
    tasks: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Short unique id like t1, t2' },
          title: { type: 'string' },
          description: { type: 'string', description: 'Self-contained instructions an engineer could follow without the rest of the plan.' },
          files: { type: 'array', items: { type: 'string' }, description: 'Files likely to be read or changed.' },
          depends_on: { type: 'array', items: { type: 'string' }, description: 'Ids of tasks that must finish first.' },
          acceptance: { type: 'string', description: 'How to tell the task is done (tests, behaviour).' },
        },
        required: ['id', 'title', 'description', 'files', 'depends_on', 'acceptance'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'tasks'],
  additionalProperties: false,
};

export function buildPlannerPrompt(goal) {
  return [
    'You are the planning lead for this repository. Read enough of the project to plan well, then break the goal below into tasks.',
    'Each task will be handed to a separate engineer (a Claude Code session) who sees only that task, the project summary and the results of its dependencies.',
    'Make tasks small and independently verifiable. Keep genuinely hard or risky work (design decisions, cross-cutting changes, security, data migrations) in their own tasks, separate from mechanical work, so each can go to the right level of engineer.',
    'Order dependencies correctly. Do not change any files.',
    '',
    `GOAL: ${goal}`,
  ].join('\n');
}

/** Throw on a structurally broken plan: duplicate ids, unknown dependencies, or cycles. */
export function validatePlan(plan) {
  if (!plan || !Array.isArray(plan.tasks) || plan.tasks.length === 0) throw new Error('plan has no tasks');
  const ids = new Set();
  for (const t of plan.tasks) {
    if (!t.id || ids.has(t.id)) throw new Error(`duplicate or missing task id "${t.id}"`);
    ids.add(t.id);
  }
  for (const t of plan.tasks) for (const d of t.depends_on ?? []) if (!ids.has(d)) throw new Error(`task ${t.id} depends on unknown task ${d}`);
  topoOrder(plan.tasks); // throws on cycles
  return plan;
}

/** Dependency order (Kahn), stable with respect to plan order. */
export function topoOrder(tasks) {
  const remaining = new Map(tasks.map((t) => [t.id, new Set(t.depends_on ?? [])]));
  const order = [];
  while (remaining.size) {
    const ready = tasks.filter((t) => remaining.has(t.id) && remaining.get(t.id).size === 0);
    if (!ready.length) throw new Error(`dependency cycle among tasks: ${[...remaining.keys()].join(', ')}`);
    for (const t of ready) {
      order.push(t);
      remaining.delete(t.id);
      for (const deps of remaining.values()) deps.delete(t.id);
    }
  }
  return order;
}

export async function makePlan({ goal, projectDir, config, runClaudeImpl = runClaude }) {
  const p = config.planner;
  const r = await runClaudeImpl(
    buildPlannerPrompt(goal),
    { model: p.model, schema: PLAN_SCHEMA, allowedTools: p.allowedTools, disallowedTools: p.disallowedTools, maxBudgetUsd: p.maxBudgetUsd },
    { cwd: projectDir, timeoutMs: config.run.timeoutMs },
  );
  if (!r.ok || !r.structured) throw new Error(`planner failed (${r.subtype}): ${String(r.result).slice(0, 300)}`);
  const plan = validatePlan(r.structured);
  return { goal, createdAt: new Date().toISOString(), planner: { model: r.model, costUsd: r.costUsd, durationMs: r.durationMs }, ...plan };
}
