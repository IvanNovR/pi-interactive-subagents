/** Small, artifact-backed live tree shared by the Pi processes in one family.
 * Metadata is immutable; stop/settled/outcome sidecars have independent writers.
 * Run IDs (not names or session IDs) scope every cancellation, including resumes.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface LiveRun {
  id: string;
  parentId: string;
  name: string;
  agent?: string;
  surface: string;
  sessionFile: string;
  activityFile?: string;
  startTime: number;
  cli?: string;
  cwd?: string;
  /** tmux socket/server identity prevents stale records targeting reused pane IDs. */
  tmux?: string;
}
export interface StopOutcome { status: "stopped" | "stop_failed"; forced: boolean; errors: string[] }

export function tmuxIdentity(value = process.env.TMUX): string | undefined {
  // The final TMUX component is the session, not the server. Panes in the same
  // family can move between sessions on that server without changing identity.
  return value?.split(",").slice(0, 2).join(",");
}

export function runtimeFile(dir: string, id: string, suffix = "json"): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid subagent run ID");
  return join(dir, `${id}.${suffix}`);
}
export function writeRuntime(dir: string, id: string, suffix: string, data: unknown): void {
  mkdirSync(dir, { recursive: true });
  const path = runtimeFile(dir, id, suffix);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(data));
  renameSync(temp, path);
}
export function readRuntime<T>(dir: string, id: string, suffix: string): T | undefined {
  try { return JSON.parse(readFileSync(runtimeFile(dir, id, suffix), "utf8")); } catch { return undefined; }
}
export function readLiveRuns(dir: string): LiveRun[] {
  try {
    return readdirSync(dir).filter((file) => file.endsWith(".json")).flatMap((file) => {
      const run = readRuntime<LiveRun>(dir, file.slice(0, -5), "json");
      return run && run.id === file.slice(0, -5) && typeof run.parentId === "string" &&
        typeof run.surface === "string" && typeof run.name === "string" ? [run] : [];
    });
  } catch { return []; }
}
export function descendants(runs: LiveRun[], parentId: string): LiveRun[] {
  const selected = new Set([parentId]);
  const result: LiveRun[] = [];
  for (let changed = true; changed;) {
    changed = false;
    for (const run of runs) {
      if (selected.has(run.parentId) && !selected.has(run.id)) {
        selected.add(run.id); result.push(run); changed = true;
      }
    }
  }
  return result;
}
export function isStopping(dir: string | undefined, id: string | undefined): boolean {
  if (!dir || !id) return false;
  const seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id);
    if (existsSync(runtimeFile(dir, id, "stop"))) return true;
    id = readRuntime<LiveRun>(dir, id, "json")?.parentId;
  }
  return false;
}
export function stopOutcome(dir: string, id: string): StopOutcome | undefined {
  return readRuntime<StopOutcome>(dir, id, "outcome");
}
export function markStop(dir: string, id: string): void {
  // Exclusive creation makes repeated requests idempotent without changing time.
  mkdirSync(dir, { recursive: true });
  try { writeFileSync(runtimeFile(dir, id, "stop"), JSON.stringify({ at: Date.now() }), { flag: "wx" }); }
  catch (error: any) { if (error.code !== "EEXIST") throw error; }
}
export function assertNotStopping(dir?: string, id?: string): void {
  if (isStopping(dir, id)) throw new Error("This subagent subtree is stopping; launching or messaging is refused.");
}
