/** Bounded, external cancellation. Works even when a child Pi event loop hangs.
 * tmux Escape is always first. A child acknowledges only after Pi and its tools
 * settle. POSIX process snapshots retain active bash children across reparenting
 * (Pi's bash uses a separate process group, so kill-pane alone is insufficient).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { closeSurface, sendEscape, surfacePid } from "./tmux.ts";
import { descendants, markStop, readLiveRuns, readRuntime, runtimeFile, stopOutcome, tmuxIdentity, writeRuntime, type LiveRun, type StopOutcome } from "./runtime.ts";

export const STOP_GRACE_MS = 5000;
export const STOP_TERM_MS = 1000;
export const STOP_KILL_MS = 1000;
const TICK_MS = 100;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface ProcessInfo { pid: number; ppid: number; pgid: number; state: string; started: string }
export function parseProcessTable(text: string): ProcessInfo[] {
  return text.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    return match ? [{ pid: +match[1], ppid: +match[2], pgid: +match[3], state: match[4], started: match[5] }] : [];
  });
}
export function processTable(): ProcessInfo[] {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error(`Subagent stop process cleanup is unsupported on ${process.platform}; use macOS, Linux, or WSL.`);
  }
  return parseProcessTable(execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,stat=,lstart="], {
    encoding: "utf8", timeout: 2000, maxBuffer: 8 * 1024 * 1024,
  }));
}
export function processDescendants(table: ProcessInfo[], roots: Set<number>): ProcessInfo[] {
  const selected = new Set(roots);
  for (let changed = true; changed;) {
    changed = false;
    for (const row of table) if (selected.has(row.ppid) && !selected.has(row.pid)) {
      selected.add(row.pid); changed = true;
    }
  }
  return table.filter((row) => selected.has(row.pid));
}
export interface StopOps {
  panePid: typeof surfacePid;
  escape: typeof sendEscape;
  close: typeof closeSurface;
  processes: typeof processTable;
  kill: (pid: number, signal: NodeJS.Signals) => void;
}
const defaultOps: StopOps = {
  panePid: surfacePid, escape: sendEscape, close: closeSurface, processes: processTable,
  kill: (pid, signal) => process.kill(pid, signal),
};

const inFlight = new Map<string, Promise<StopOutcome>>();
export function stopSubtree(dir: string, selected: LiveRun, ops: StopOps = defaultOps): Promise<StopOutcome> {
  if (selected.tmux && tmuxIdentity(selected.tmux) !== tmuxIdentity()) {
    throw new Error("Subagent belongs to a different tmux server; refusing to target a potentially reused pane ID.");
  }
  const key = `${dir}/${selected.id}`;
  const prior = stopOutcome(dir, selected.id);
  if (prior) return Promise.resolve(prior);
  const pending = inFlight.get(key);
  if (pending) return pending;
  markStop(dir, selected.id);
  let claimed = false;
  try {
    writeFileSync(runtimeFile(dir, selected.id, "controller"), JSON.stringify({ pid: process.pid, at: Date.now() }), { flag: "wx" });
    claimed = true;
  } catch (error: any) { if (error.code !== "EEXIST") throw error; }
  const promise = (claimed ? performStop(dir, selected, ops) : awaitExistingStop(dir, selected.id))
    .finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

async function awaitExistingStop(dir: string, id: string): Promise<StopOutcome> {
  const deadline = Date.now() + 15000;
  do {
    const outcome = stopOutcome(dir, id);
    if (outcome) return outcome;
    await delay(TICK_MS);
  } while (Date.now() < deadline);
  return { status: "stop_failed", forced: false, errors: ["Another stop controller did not finish within 15 seconds; cleanup is unconfirmed."] };
}

async function performStop(dir: string, selected: LiveRun, ops: StopOps): Promise<StopOutcome> {
  const runs = new Map<string, LiveRun>();
  const tracked = new Map<number, ProcessInfo>();
  const errors = new Set<string>();
  let forced = false;
  const attempt = <T>(fn: () => T): T | undefined => {
    try { return fn(); } catch (error: any) { errors.add(error?.message ?? String(error)); return undefined; }
  };
  const discover = () => {
    // Mark the ancestor before scanning: children racing launch observe it and
    // refuse to submit their shell command. Re-scan throughout the grace period.
    markStop(dir, selected.id);
    for (const run of [selected, ...descendants(readLiveRuns(dir), selected.id)]) {
      // Traverse historical ancestors for discovery, but never target their old
      // panes or rewrite their completed results. A tmux server restart can
      // reuse pane IDs, so finished metadata is not a live process identity.
      if (runs.has(run.id)) continue;
      const prior = stopOutcome(dir, run.id);
      // Failed cleanup is not terminal success, even if its watcher already
      // marked the run finished. Do not silently lose it from an ancestor stop.
      // A fresh controller cannot safely rediscover tools already reparented by
      // that failed attempt, so preserve and propagate the unconfirmed result.
      if (prior?.status === "stop_failed") {
        errors.add(`Subagent "${run.name}" has unconfirmed cleanup from a previous failed stop: ${prior.errors.join("; ") || "unknown cleanup failure"}`);
        continue;
      }
      if (readRuntime(dir, run.id, "finished") || prior) continue;
      if (run.tmux && tmuxIdentity(run.tmux) !== tmuxIdentity()) {
        errors.add(`Cannot safely stop ${run.name}: it belongs to a different tmux server`);
        continue;
      }
      runs.set(run.id, run);
      markStop(dir, run.id);
      const pid = attempt(() => ops.panePid(run.surface));
      if (pid) {
        // Bind a newly discovered pane PID exactly once, before Escape. If it
        // has already disappeared from this snapshot, never adopt a later
        // occupant of that PID as our root (or traverse that occupant's tools).
        const table = attempt(ops.processes);
        if (table?.some((row) => row.pid === pid)) {
          for (const row of processDescendants(table, new Set([pid]))) {
            if (row.pid !== process.pid) tracked.set(row.pid, row);
          }
        } else if (table) errors.add(`Cannot bind pane process ${pid} for "${run.name}" in its initial snapshot; cleanup is unconfirmed`);
      }
    }
  };
  const sample = () => {
    const table = attempt(ops.processes);
    if (!table) return undefined;
    // Retain identities from before Escape, including separate-group bash.
    const liveRoots = new Set([...tracked.values()].filter((previous) =>
      table.some((row) => row.pid === previous.pid && row.started === previous.started)
    ).map((row) => row.pid));
    for (const row of processDescendants(table, liveRoots)) {
      if (row.pid !== process.pid) tracked.set(row.pid, row);
    }
    return table.filter((row) => !row.state.startsWith("Z") &&
      tracked.get(row.pid)?.started === row.started);
  };
  discover();
  sample(); // MUST happen before Escape can reap/reparent active bash children.
  const escaped = new Set<string>();
  const graceDeadline = Date.now() + STOP_GRACE_MS;
  let settled = false;
  do {
    discover(); sample();
    for (const run of runs.values()) if (!escaped.has(run.id)) {
      escaped.add(run.id);
      if (attempt(() => ops.panePid(run.surface))) attempt(() => ops.escape(run.surface));
    }
    discover(); sample();
    settled = [...runs.values()].every((run) => escaped.has(run.id) &&
      (readRuntime(dir, run.id, "settled") !== undefined || attempt(() => ops.panePid(run.surface)) === undefined));
    if (settled) break;
    await delay(TICK_MS);
  } while (Date.now() < graceDeadline);

  discover(); sample();
  for (const run of runs.values()) if (!escaped.has(run.id)) {
    escaped.add(run.id);
    if (attempt(() => ops.panePid(run.surface))) attempt(() => ops.escape(run.surface));
  }
  const signalRemaining = (signal: NodeJS.Signals) => {
    const remaining = sample();
    // Children before parents; retained identities avoid signalling recycled PIDs.
    for (const row of (remaining ?? []).reverse()) attempt(() => {
      try { ops.kill(row.pid, signal); } catch (error: any) { if (error.code !== "ESRCH") throw error; }
    });
  };
  if (!settled) {
    forced = true;
    signalRemaining("SIGTERM");
    await delay(STOP_TERM_MS);
    signalRemaining("SIGKILL");
  }
  // Close only after cancellation settled, or after bounded forced termination.
  for (const run of [...runs.values()].reverse()) attempt(() => {
    if (ops.panePid(run.surface)) ops.close(run.surface);
  });
  // kill-pane sends SIGHUP to the terminal, not to bash's separate group. Clean
  // any captured survivors explicitly even after a cooperative idle ack.
  let remaining = sample();
  if (remaining?.length) {
    await delay(250); // allow ordinary SIGHUP/reaping after pane closure
    remaining = sample();
  }
  if (remaining?.length) {
    forced = true;
    signalRemaining("SIGTERM");
    await delay(STOP_TERM_MS);
    signalRemaining("SIGKILL");
  }
  const killDeadline = Date.now() + STOP_KILL_MS;
  do {
    remaining = sample();
    if (!remaining?.length) break;
    await delay(TICK_MS);
  } while (Date.now() < killDeadline);
  if (remaining?.length) errors.add(`Processes still alive after stop: ${remaining.map((row) => row.pid).join(", ")}`);
  for (const run of runs.values()) if (attempt(() => ops.panePid(run.surface))) errors.add(`Pane ${run.surface} is still open`);
  const outcome: StopOutcome = { status: errors.size ? "stop_failed" : "stopped", forced, errors: [...errors] };
  // Pi lazily persists new sessions. Cancellation during the first provider
  // request may leave only a loadout, with no transcript yet. Keep that name
  // resumable even when its direct parent was also killed in this subtree.
  if (outcome.status === "stopped") for (const run of runs.values()) {
    if (run.cli === "claude" || existsSync(run.sessionFile) || !existsSync(`${run.sessionFile}.loadout.json`)) continue;
    try {
      mkdirSync(dirname(run.sessionFile), { recursive: true });
      writeFileSync(run.sessionFile, JSON.stringify({ type: "session", version: 3, id: randomUUID(),
        timestamp: new Date().toISOString(), cwd: run.cwd ?? process.cwd() }) + "\n", { flag: "wx" });
    } catch (error: any) {
      if (error.code !== "EEXIST") {
        outcome.status = "stop_failed";
        outcome.errors.push(`Stopped, but could not preserve resumable session for ${run.name}: ${error.message}`);
      }
    }
  }
  // Each direct parent's existing watcher emits one completion. Stopping parents
  // suppress delivery, so stopping a subtree wakes only its surviving parent.
  for (const run of runs.values()) writeRuntime(dir, run.id, "outcome", outcome);
  // A finished selected ancestor can still own live/failed descendants. Retain
  // the subtree request's outcome for duplicate callers, without revisiting its
  // old pane or changing other historical ancestors' completed results.
  if (!runs.has(selected.id)) writeRuntime(dir, selected.id, "outcome", outcome);
  return outcome;
}
