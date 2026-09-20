// Shadow mode: watch a live firstmate home and record what Jev WOULD have decided for every
// crewmate wake, without changing firstmate's behaviour.
//
// Two sources, both read-only:
//   state/.wake-queue        wakes delivered to the first mate: epoch \t seq \t kind \t key \t payload
//                            (bin/fm-wake-lib.sh fm_wake_append_locked). Rows stay until the
//                            first mate acknowledges them, so a few-second poll sees them all.
//   state/.watch-triage.log  wakes the watcher absorbed itself: "[ts] absorbed <label> (...): <window>"
//
// For each crewmate wake (kinds signal/stale) we triage the task right away, while the pane
// still shows what the first mate is about to see, and append one JSON line to the shadow log.
import { readFileSync, existsSync, appendFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const CREW_KINDS = ['signal', 'stale'];

export function parseQueue(text) {
  return String(text ?? '')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [epoch, seq, kind, key, ...rest] = line.split('\t');
      return { epoch: Number(epoch), seq, kind, key, payload: rest.join('\t') };
    })
    .filter((r) => Number.isFinite(r.epoch) && r.kind);
}

/** "[2026-09-18T10:00:00+0100] absorbed stale (…): fm-42" -> { ts, message, window } */
export function parseTriageLine(line) {
  const m = /^\[([^\]]+)\]\s+(.*)$/.exec(line);
  if (!m) return null;
  const window = /:\s*(\S+)\s*$/.exec(m[2])?.[1] ?? null;
  return { ts: m[1], message: m[2], window, absorbed: /^absorbed\b/.test(m[2]) };
}

/** Map a window/terminal name to a task id the way firstmate's window_to_task does. */
export function windowToTask(win, stateDir) {
  if (!win || !existsSync(stateDir)) return null;
  for (const f of readdirSync(stateDir).filter((n) => n.endsWith('.meta'))) {
    const meta = readFileSync(join(stateDir, f), 'utf8');
    const field = (k) => [...meta.matchAll(new RegExp(`^${k}=(.*)$`, 'gm'))].at(-1)?.[1];
    if (field('window') === win || field('terminal') === win) return f.slice(0, -'.meta'.length);
  }
  return null;
}

/** Task id for a queue row: signal keys are "<id>.status", stale keys are windows. */
export function taskForWake(row, stateDir) {
  if (row.kind === 'signal') return row.key.endsWith('.status') ? row.key.slice(0, -'.status'.length) : null;
  if (row.kind === 'stale') return windowToTask(row.key, stateDir);
  return null;
}

/** The herdr pane id (e.g. "w2:p3") a task's meta records, or null. The last one wins. */
export function herdrPaneForTask(taskId, stateDir) {
  const f = join(stateDir, `${taskId}.meta`);
  if (!existsSync(f)) return null;
  return [...readFileSync(f, 'utf8').matchAll(/\bw\d+:p\d+\b/g)].at(-1)?.[0] ?? null;
}

const paneExcerpt = (pane, n = 15) => String(pane ?? '').trimEnd().split('\n').slice(-n).join('\n');

export class ShadowWatcher {
  /**
   * @param {object} o
   * @param {string} o.fmHome     firstmate home
   * @param {string} o.logFile    JSONL output
   * @param {(taskId:string, wakeKind?:string)=>Promise<{input:object, result:object}>} o.triageTask
   */
  constructor({ fmHome, logFile, triageTask, herdrState = null, now = () => new Date().toISOString() }) {
    this.state = join(fmHome, 'state');
    this.herdrState = herdrState; // optional (paneId) => agent_status, the third judge
    this.logFile = logFile;
    this.triageTask = triageTask;
    this.now = now;
    this.seen = new Set();
    this.triageOffset = 0;
  }

  /** Skip everything already on disk when shadowing starts (only judge wakes we see live). */
  primeFromDisk() {
    for (const r of this.#queueRows()) this.seen.add(`${r.epoch}:${r.seq}`);
    const f = join(this.state, '.watch-triage.log');
    this.triageOffset = existsSync(f) ? statSync(f).size : 0;
  }

  #queueRows() {
    const f = join(this.state, '.wake-queue');
    return existsSync(f) ? parseQueue(readFileSync(f, 'utf8')) : [];
  }

  #newTriageLines() {
    const f = join(this.state, '.watch-triage.log');
    if (!existsSync(f)) return [];
    const buf = readFileSync(f);
    if (buf.length < this.triageOffset) this.triageOffset = 0; // log was rotated
    const text = buf.subarray(this.triageOffset).toString('utf8');
    const complete = text.slice(0, text.lastIndexOf('\n') + 1);
    this.triageOffset += Buffer.byteLength(complete);
    return complete.split('\n').filter(Boolean).map(parseTriageLine).filter(Boolean);
  }

  async #judge(type, taskId, extra, wakeKind) {
    let input = {};
    let result;
    try {
      ({ input, result } = await this.triageTask(taskId, wakeKind));
    } catch (e) {
      result = { action: 'wake', source: 'error', reason: e.message };
    }
    let herdr;
    if (this.herdrState) {
      const pane = herdrPaneForTask(taskId, this.state);
      try {
        herdr = { pane, state: pane ? await this.herdrState(pane) : 'no-pane' };
      } catch (e) {
        herdr = { pane, state: 'error', error: e.message.split('\n')[0] };
      }
    }
    const rec = {
      at: this.now(),
      type,
      task: taskId,
      ...extra,
      ...(herdr ? { herdr } : {}),
      statusLine: input.statusLine ?? null,
      pane: paneExcerpt(input.pane),
      jev: { action: result.action, source: result.source, crewState: result.crewState ?? null, confidence: result.confidence ?? null, needsSupervisor: result.needsSupervisor ?? null, looping: result.looping ?? null, reason: result.reason, latencyMs: result.latencyMs ?? null, cost: result.cost ?? null },
    };
    appendFileSync(this.logFile, JSON.stringify(rec) + '\n');
    return rec;
  }

  /** One poll. Returns the records written. */
  async poll() {
    const out = [];
    for (const r of this.#queueRows()) {
      const id = `${r.epoch}:${r.seq}`;
      if (this.seen.has(id)) continue;
      this.seen.add(id);
      if (!CREW_KINDS.includes(r.kind)) continue;
      const task = taskForWake(r, this.state);
      if (!task) continue;
      out.push(await this.#judge('firstmate_woke', task, { wake: { kind: r.kind, key: r.key, payload: r.payload } }, r.kind));
    }
    for (const t of this.#newTriageLines()) {
      if (!t.absorbed) continue;
      const task = windowToTask(t.window, this.state);
      if (!task) continue;
      out.push(await this.#judge('firstmate_absorbed', task, { absorbed: t.message }, 'stale'));
    }
    return out;
  }
}

/** Summarise a shadow log: where Jev and firstmate agree, and where they differ. */
export function summarize(records) {
  const woke = records.filter((r) => r.type === 'firstmate_woke');
  const absorbed = records.filter((r) => r.type === 'firstmate_absorbed');
  const jevWouldAbsorb = woke.filter((r) => r.jev.action === 'absorb');
  const jevWouldWake = absorbed.filter((r) => r.jev.action === 'wake');
  const byKind = {};
  for (const r of woke) byKind[r.wake.kind] = (byKind[r.wake.kind] ?? 0) + 1;
  const states = {};
  for (const r of records) states[r.jev.crewState ?? r.jev.source] = (states[r.jev.crewState ?? r.jev.source] ?? 0) + 1;
  const herdrStates = {};
  for (const r of records) if (r.herdr) herdrStates[r.herdr.state] = (herdrStates[r.herdr.state] ?? 0) + 1;
  const herdrBlockedAbsorbed = absorbed.filter((r) => r.herdr?.state === 'blocked').length;
  const lat = records.map((r) => r.jev.latencyMs).filter(Number.isFinite).sort((a, b) => a - b);
  return {
    total: records.length,
    firstmateWoke: woke.length,
    wokeByKind: byKind,
    jevWouldAbsorb: jevWouldAbsorb.length,
    firstmateAbsorbed: absorbed.length,
    jevWouldWake: jevWouldWake.length,
    errors: records.filter((r) => r.jev.source === 'error').length,
    crewStates: states,
    herdrStates,
    herdrBlockedAbsorbed,
    latencyP50: lat.length ? lat[Math.floor(lat.length / 2)] : null,
    cost: records.reduce((s, r) => s + (r.jev.cost ?? 0), 0),
    review: [...jevWouldAbsorb, ...jevWouldWake],
  };
}

export function formatSummary(s) {
  const lines = [
    `shadow records: ${s.total}   jev errors: ${s.errors}   latency p50: ${s.latencyP50 ?? '-'} ms   jev cost: $${s.cost.toFixed(6)}`,
    `firstmate WOKE the first mate on ${s.firstmateWoke} crew wake(s) ${JSON.stringify(s.wokeByKind)}`,
    `  -> Jev would have ABSORBED ${s.jevWouldAbsorb} of them (first-mate turns it could save)`,
    `firstmate ABSORBED ${s.firstmateAbsorbed} wake(s) itself`,
    `  -> Jev would have WOKEN on ${s.jevWouldWake} of them (possible misses by the heuristic)`,
    `Jev crew states: ${Object.entries(s.crewStates).map(([k, v]) => `${k}=${v}`).join(' ') || '-'}`,
  ];
  if (Object.keys(s.herdrStates ?? {}).length) {
    lines.push(`herdr states: ${Object.entries(s.herdrStates).map(([k, v]) => `${k}=${v}`).join(' ')}   (herdr said blocked on ${s.herdrBlockedAbsorbed} wake(s) firstmate absorbed)`);
  }
  if (s.review.length) lines.push('', 'Disagreements to review:');
  for (const r of s.review) {
    lines.push(`\n[${r.at}] ${r.task}  firstmate=${r.type === 'firstmate_woke' ? 'woke' : 'absorbed'}  jev=${r.jev.action} (${r.jev.crewState}, conf ${r.jev.confidence})${r.herdr ? `  herdr=${r.herdr.state}` : ''}`);
    lines.push(`  ${r.type === 'firstmate_woke' ? `wake: ${r.wake.kind} ${r.wake.payload}` : r.absorbed}`);
    lines.push(`  status: ${r.statusLine ?? '-'}   jev reason: ${r.jev.reason}`);
    lines.push(r.pane.split('\n').map((l) => `  | ${l}`).join('\n'));
  }
  return lines.join('\n');
}
