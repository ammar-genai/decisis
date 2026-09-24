// Durable identities for plans and tasks.
//
// The ledger is per-project and spans every run ever made there, so a task id alone ("t1") is not
// an identity: a later plan for a different goal reuses the same ids, and its work would be
// skipped as "already done". Two hashes fix that.
//
//   planId   from the goal   - a re-plan of the same goal resumes; a different goal does not.
//   rev      from the task   - editing a task's title, description or scope makes it new work.
//
// Both are content hashes rather than random ids, so resuming survives deleting plan.json.
import { createHash } from 'node:crypto';

const hash = (parts) => createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 12);

/** Stable across re-plans of the same goal. */
export const planIdOf = (goal) => hash([String(goal ?? '').trim()]);

/** Changes when the work itself changes, so an edited task is not treated as already done. */
export const taskRevOf = (task) =>
  hash([task?.id ?? '', task?.title ?? '', task?.description ?? '', (task?.files ?? []).join(','), (task?.depends_on ?? []).join(',')]);
