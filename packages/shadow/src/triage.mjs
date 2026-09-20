// Wake triage: should firstmate's watcher ABSORB this crewmate wake, or WAKE the first mate?
//
// firstmate's watcher (bin/fm-watch.sh + bin/fm-classify-lib.sh) wakes the first mate on
// captain-relevant status verbs, and on no-verb signals / stale panes unless it has positive
// "provably working" evidence. Every wake costs a full first-mate (Claude) turn. This module
// asks Jev to read the pane like a human would, for ~$0.00002 and ~250 ms.
//
// Safety policy: absorbing is the only risky outcome (a missed wake), so Jev must be
// confident the crew is working or deliberately waiting, and must not see a need to act or
// a loop. Anything else — including errors — wakes the first mate.
import { jevDecider, DEFAULT_JEV_MODEL as DEFAULT_MODEL } from '@decisis/core';

// Same terminal verbs as firstmate's status_is_terminal_verb (fm-classify-lib.sh).
export const TERMINAL_VERBS = ['done', 'needs-decision', 'blocked', 'failed'];

export const CREW_STATES = {
  working: 'Actively making progress: a tool, test, build, install or model turn is running, or output is still changing toward the task goal.',
  waiting_external: 'Deliberately idle on a known external dependency expected to clear on its own (CI run, upstream merge, scheduled time) and said so.',
  stuck_or_looping: 'Not progressing: repeating the same failing action or error, oscillating between edits, out of context, stopped mid-task without saying why, or unsure how to continue.',
  needs_decision: 'Waiting for a human or supervisor answer: asked a question, offered options, or sits at an approval / permission prompt.',
  done: 'Says its assigned task is finished (PR opened, report written, change merged) and has stopped.',
  failed: 'Hit an unrecoverable error, crashed, the agent process exited, or it gave up.',
};

export const ABSORB_STATES = ['working', 'waiting_external'];

// A stale wake on a crewmate whose terminal status line was ALREADY delivered: the pane
// still showing that same situation is nothing new, so it may be absorbed. These are the
// crew states consistent with each terminal verb.
export const SAME_AS_REPORTED = {
  done: ['done'],
  'needs-decision': ['needs_decision'],
  blocked: ['stuck_or_looping', 'needs_decision'],
  failed: ['failed', 'stuck_or_looping'],
};

// What the first mate should probably do, per state (a hint, not an order).
export const HINTS = {
  stuck_or_looping: 'nudge the crewmate with guidance (fm-send) or re-scope the task',
  needs_decision: 'answer the question or escalate it to the captain',
  done: 'review the result and follow the project merge mode',
  failed: 'inspect the pane (fm-peek) and decide: retry, re-dispatch or report',
  working: 'nothing to do',
  waiting_external: 'nothing to do until the wait clears',
};

export const TRIAGE_QUESTIONS = {
  crew_state: {
    type: 'choice',
    instructions:
      'You supervise a coding agent ("crewmate") working in a terminal. Read `task.brief`, `last_status_line` and `pane_tail` (the most recent terminal output, newest at the bottom). Which state is the crewmate in RIGHT NOW?',
    criteria: CREW_STATES,
  },
  needs_supervisor: {
    type: 'noul',
    instructions: 'Does the supervisor need to act now (answer, unblock, review, or restart the crewmate)?',
    criteria: {
      true: 'The crewmate is finished, asking something, stuck, looping, crashed, or idle without a declared reason.',
      false: 'The crewmate is visibly progressing on its own or waiting on a declared external dependency.',
    },
  },
  looping: {
    type: 'noul',
    instructions: 'Is the crewmate repeating the same action, error, or edit without making progress?',
    criteria: { true: 'Same failure or action repeated two or more times with no new result.', false: 'Each step produces new progress or it has not repeated itself.' },
  },
};

export const DEFAULT_POLICY = { confidenceFloor: 0.7, maxNeedsSupervisor: 0.3, maxLooping: 0.5 };

/** Leading verb of a firstmate status line ("done: PR #57" -> "done"), lowercase, or null. */
export function statusVerb(line) {
  const m = /^\s*([a-z][a-z-]*)\s*:/i.exec(line ?? '');
  return m ? m[1].toLowerCase() : null;
}

/** Keep the newest part of the pane: at most maxLines lines and maxChars characters. */
export function trimPane(pane, { maxLines = 60, maxChars = 6000 } = {}) {
  let lines = String(pane ?? '').replace(/\s+$/, '').split('\n');
  if (lines.length > maxLines) lines = lines.slice(-maxLines);
  let text = lines.join('\n');
  if (text.length > maxChars) text = text.slice(-maxChars);
  return text;
}

export function buildTriageState({ taskId, brief, statusLine, pane, idleSeconds, alreadyReported = false }) {
  const state = {
    task: { id: taskId ?? 'unknown', brief: brief ?? '(no brief available)' },
    last_status_line: statusLine || '(none)',
    pane_tail: trimPane(pane),
  };
  if (Number.isFinite(idleSeconds)) state.pane_unchanged_seconds = idleSeconds;
  if (alreadyReported) state.supervisor_already_saw_last_status_line = true;
  return state;
}

/** Pure policy: turn Jev's answers into absorb | wake. */
export function decideAction(answers, policy = DEFAULT_POLICY) {
  const { crew_state: cs, needs_supervisor: ns, looping } = answers;
  const base = {
    crewState: cs.choice,
    confidence: cs.confidence ?? null,
    needsSupervisor: ns.noul,
    looping: looping.noul,
    hint: HINTS[cs.choice] ?? null,
  };
  const reasons = [];
  if (!ABSORB_STATES.includes(cs.choice)) reasons.push(`crew_state=${cs.choice}`);
  if ((cs.confidence ?? 0) < policy.confidenceFloor) reasons.push(`confidence ${cs.confidence} < ${policy.confidenceFloor}`);
  if (ns.noul > policy.maxNeedsSupervisor) reasons.push(`needs_supervisor ${ns.noul} > ${policy.maxNeedsSupervisor}`);
  if (looping.noul > policy.maxLooping) reasons.push(`looping ${looping.noul} > ${policy.maxLooping}`);
  if (reasons.length === 0) return { action: 'absorb', reason: `jev: ${cs.choice}`, ...base };
  return { action: 'wake', reason: reasons.join('; '), ...base };
}

/**
 * Policy for a stale wake after an already-delivered terminal verb: absorb when the pane
 * still shows the reported situation (confidently, and not looping); wake if it diverged.
 */
export function decideAlreadyReported(answers, verb, policy = DEFAULT_POLICY) {
  const { crew_state: cs, needs_supervisor: ns, looping } = answers;
  const base = { crewState: cs.choice, confidence: cs.confidence ?? null, needsSupervisor: ns.noul, looping: looping.noul, hint: HINTS[cs.choice] ?? null };
  const same = SAME_AS_REPORTED[verb].includes(cs.choice);
  const confident = (cs.confidence ?? 0) >= policy.confidenceFloor;
  if (same && confident && looping.noul <= policy.maxLooping) {
    return { action: 'absorb', reason: `"${verb}:" already reported and the pane still shows ${cs.choice}; nothing new`, ...base };
  }
  const why = !same ? `pane now shows ${cs.choice}, not the reported "${verb}:"` : !confident ? `confidence ${cs.confidence} < ${policy.confidenceFloor}` : `looping ${looping.noul} > ${policy.maxLooping}`;
  return { action: 'wake', reason: why, ...base };
}

/**
 * Triage one wake. Deterministic first (a terminal status verb always wakes, exactly like
 * firstmate), then Jev. Never throws: an API failure returns a fail-safe wake.
 */
export async function triageWake({ key, taskId, brief, statusLine, pane, idleSeconds, wakeKind, policy = DEFAULT_POLICY, model = DEFAULT_MODEL, decideImpl, ...rest }) {
  const verb = statusVerb(statusLine);
  const terminal = TERMINAL_VERBS.includes(verb);
  // A fresh terminal verb (a signal) always wakes. A STALE wake whose last line is a terminal
  // verb means the first mate already got that verb, so ask Jev whether anything changed.
  const alreadyReported = terminal && wakeKind === 'stale';
  if (terminal && !alreadyReported) {
    return { action: 'wake', source: 'verb', reason: `terminal status verb "${verb}:"`, crewState: null };
  }
  const state = buildTriageState({ taskId, brief, statusLine, pane, idleSeconds, alreadyReported });
  try {
    const decide = decideImpl ?? jevDecider({ key, model, sessionId: taskId ? `fm-${taskId}` : undefined, title: 'decisis-shadow', ...rest });
    const r = await decide(state, TRIAGE_QUESTIONS);
    const decision = alreadyReported ? decideAlreadyReported(r.answers, verb, policy) : decideAction(r.answers, policy);
    return { ...decision, source: 'jev', model: r.model, latencyMs: r.latencyMs, cost: r.costUsd ?? null, answers: r.answers };
  } catch (e) {
    return { action: 'wake', source: 'error', reason: `jev unavailable (${e.message}); failing safe`, crewState: null };
  }
}
