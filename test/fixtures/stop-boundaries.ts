/** Isolated process: mocks only the tmux boundary, never launches Pi/models. */
import assert from "node:assert/strict";
import { mock } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { markStop, readLiveRuns, readRuntime, stopOutcome, writeRuntime, type LiveRun } from "../../pi-extension/subagents/runtime.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-stop-boundaries-"));
for (const key of Object.keys(process.env)) if (key.startsWith("PI_SUBAGENT_")) delete process.env[key];
process.env.PI_CODING_AGENT_DIR = join(dir, "agent-home");
process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS = "0";
const bin = join(dir, "bin"), executed = join(dir, "pi-executed");
mkdirSync(bin);
writeFileSync(join(bin, "pi"), `#!/bin/bash\nprintf 'unexpected invocation' > '${executed}'\n`, { mode: 0o755 });
const tmuxURL = new URL("../../pi-extension/subagents/tmux.ts", import.meta.url).href;
const realTmux = await import(tmuxURL);
let runtime = "", mode: "before-dispatch" | "during-dispatch" | "ancestor-during-dispatch" = "before-dispatch";
let panes = 0, dispatches = 0, failSurface = false;
const queries: string[] = [];
const stopRun = (surface: string, ancestor = false) => {
  const run = readLiveRuns(runtime).find((entry) => entry.surface === surface)!;
  assert.ok(run, "the real launch path publishes metadata before dispatch");
  markStop(runtime, ancestor ? run.parentId : run.id);
  writeRuntime(runtime, run.id, "outcome", { status: "stopped", forced: false, errors: [] });
};
mock.module(tmuxURL, { namedExports: {
  ...realTmux,
  isMuxAvailable: () => true,
  createSurface: () => {
    if (failSurface) throw new Error("fixture pane creation failed");
    const surface = `%fixture-${++panes}`;
    if (mode === "before-dispatch") queueMicrotask(() => stopRun(surface));
    return surface;
  },
  surfacePid: (surface: string) => { queries.push(surface); return undefined; },
  closeSurface: () => {},
  sendLongCommand: (surface: string, command: string) => {
    dispatches++;
    // This is after the JS isStopping check, but before the shell executes the
    // generated command. Without the shell-side guard, the fake Pi runs here.
    stopRun(surface, mode === "ancestor-during-dispatch");
    execFileSync("bash", ["-c", command], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    assert.equal(existsSync(executed), false, "a late stop must prevent the Pi command from starting");
    return join(dir, "mock-script");
  },
  pollForExit: async () => ({ reason: "done", exitCode: 130 }),
} });
const { default: extension, __test__ } = await import("../../pi-extension/subagents/index.ts");
const tools = new Map<string, any>(), handlers = new Map<string, Function>();
const messages: { message: any; options: any }[] = [];
const api = {
  on: (event: string, handler: Function) => handlers.set(event, handler),
  registerTool: (tool: any) => tools.set(tool.name, tool),
  registerCommand() {}, registerMessageRenderer() {}, getAllTools: () => [],
  sendMessage: (message: any, options: any) => messages.push({ message, options }),
};
const parentFile = join(dir, "parent.jsonl");
writeFileSync(parentFile, JSON.stringify({ type: "session", version: 3, id: "parent", cwd: dir }) + "\n");
const ctx = { cwd: dir, sessionManager: {
  getSessionFile: () => parentFile, getSessionId: () => "parent", getSessionDir: () => dir,
} };
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
try {
  extension(api as any);
  runtime = __test__.ensureRuntime(ctx);
  const spawn = (name: string) => tools.get("subagent").execute("spawn", { agent: "scout", name, task: "No model may execute" }, undefined, undefined, ctx);
  const resume = (name: string) => tools.get("subagent_message").execute("resume", { name, message: "Continue" }, undefined, undefined, ctx);

  // Explicit names must never replace an existing handle, whether launching,
  // running or persisted. The real tool trims and reserves before its first await.
  __test__.reservedNames.add("reserved");
  await assert.rejects(spawn(" reserved "), /already registered or launching/);
  __test__.reservedNames.delete("reserved");
  __test__.runningSubagents.set("named-fixture", { name: "running" } as any);
  await assert.rejects(spawn("running"), /already registered or launching/);
  __test__.runningSubagents.delete("named-fixture");
  assert.equal(panes, 0, "rejected names must not create panes");

  failSurface = true;
  await assert.rejects(spawn("failed-launch"), /fixture pane creation failed/);
  assert.equal(__test__.reservedNames.has("failed-launch"), false, "failed launch releases its reservation");
  failSurface = false;

  const pending = spawn(" race ");
  assert.equal(__test__.reservedNames.has("race"), true);
  await assert.rejects(spawn("race"), /already registered or launching/);
  const first = await pending;
  assert.equal(first.details.name, "race", "explicit names are trimmed");
  assert.equal(__test__.reservedNames.has("race"), false);
  await flush();
  const registryFile = join(dir, "artifacts", "parent", "subagent-registry.json");
  const registryBefore = readFileSync(registryFile, "utf8");
  await assert.rejects(spawn("race"), /already registered or launching/);
  assert.equal(readFileSync(registryFile, "utf8"), registryBefore, "duplicate must preserve the saved resume handle");
  assert.equal(panes, 1);
  assert.equal(dispatches, 0, "stop during initial launch preparation prevents dispatch");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].message.details.stop.status, "stopped");
  assert.ok(existsSync(first.details.sessionFile), "cancelled pre-dispatch launches retain a resumable session");

  mode = "during-dispatch";
  const resumed = await resume("race");
  await flush();
  assert.equal(dispatches, 1, "resumed launch reached the actual dispatch boundary");
  assert.notEqual(resumed.details.id, first.details.id);
  assert.equal(messages.length, 2);
  assert.equal(messages[1].message.details.stop.status, "stopped");

  await spawn("late-initial");
  await flush();
  assert.equal(dispatches, 2, "initial launch also checks stop markers inside the dispatched shell");
  assert.equal(messages.length, 3);

  mode = "before-dispatch";
  await resume("race");
  await flush();
  assert.equal(dispatches, 2, "stop during resume preparation also prevents dispatch");
  assert.equal(messages.length, 4);
  for (const { message, options } of messages) {
    assert.equal(message.customType, "subagent_result");
    assert.equal(message.details.stop.status, "stopped");
    assert.deepEqual(options, { triggerTurn: true, deliverAs: "steer" });
  }

  // Exercise the public tool, not just stopSelected: the selected ancestor has
  // finished, but its descendant still needs cancellation. Its old pane is not
  // a live process and must never be queried or targeted.
  const parentId = readLiveRuns(runtime)[0].parentId;
  const ancestor: LiveRun = { id: "finished-ancestor", parentId, name: "finished-ancestor", surface: "%historical",
    sessionFile: join(dir, "ancestor.jsonl"), startTime: Date.now() };
  const child: LiveRun = { ...ancestor, id: "active-descendant", parentId: ancestor.id, name: "active-descendant", surface: "%active-descendant" };
  for (const run of [ancestor, child]) writeRuntime(runtime, run.id, "json", run);
  writeRuntime(runtime, ancestor.id, "finished", {});
  const stopped = await tools.get("subagent_stop").execute("stop", { name: ancestor.name }, undefined, undefined, ctx);
  assert.equal(stopped.details.status, "stopped");
  assert.equal(stopOutcome(runtime, child.id)?.status, "stopped");
  assert.equal(queries.includes(ancestor.surface), false);
  assert.equal((await tools.get("subagent_stop").execute("repeat", { name: ancestor.name }, undefined, undefined, ctx)).details.status, "stopped");

  // Even a finished ancestor with no live pane must surface failed descendant
  // cleanup; missing panes are not proof that previously captured tools exited.
  const failedAncestor: LiveRun = { ...ancestor, id: "failed-ancestor", name: "failed-ancestor" };
  const failedChild: LiveRun = { ...child, id: "failed-descendant", name: "failed-descendant", parentId: failedAncestor.id };
  for (const run of [failedAncestor, failedChild]) { writeRuntime(runtime, run.id, "json", run); writeRuntime(runtime, run.id, "finished", {}); }
  writeRuntime(runtime, failedChild.id, "outcome", { status: "stop_failed", forced: true, errors: ["unconfirmed external tool"] });
  const failed = await tools.get("subagent_stop").execute("stop-failed", { name: failedAncestor.name }, undefined, undefined, ctx);
  assert.equal(failed.details.status, "stop_failed");
  assert.match(failed.content[0].text, /unconfirmed external tool/);

  mode = "ancestor-during-dispatch";
  await spawn("ancestor-race");
  await flush();
  assert.equal(dispatches, 3);
  assert.equal(messages.length, 4, "the actual completion path suppresses wakes inside a stopping parent");
  assert.equal(existsSync(executed), false);
  assert.ok(readLiveRuns(runtime).some((run) => readRuntime(runtime, run.id, "finished")));
  console.log("Explicit-name safety, spawn/resume preparation + dispatch races, public finished-ancestor stops, failed descendants, and real completion counts passed");
} finally {
  handlers.get("session_shutdown")?.({}, ctx);
  mock.restoreAll();
  rmSync(dir, { recursive: true, force: true });
}
