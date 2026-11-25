import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { visibleWidth } from "@mariozechner/pi-tui";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { descendants, isStopping, markStop, readLiveRuns, readRuntime, runtimeFile, stopOutcome, writeRuntime, type LiveRun } from "../pi-extension/subagents/runtime.ts";
import { parseProcessTable, processDescendants, stopSubtree, type StopOps } from "../pi-extension/subagents/stop.ts";
import extension, { __test__ } from "../pi-extension/subagents/index.ts";
import { createStatusState } from "../pi-extension/subagents/status.ts";
import subagentDone from "../pi-extension/subagents/subagent-done.ts";

// Tests must never write into the invoking subagent's actual live tree.
delete process.env.PI_SUBAGENT_RUNTIME_DIR;

function run(id: string, parentId = "root", name = id): LiveRun {
  return { id, parentId, name, surface: `%${id}`, sessionFile: `/session/${id}`, startTime: Date.now() };
}
function temp() { return mkdtempSync(join(tmpdir(), "pi-stop-")); }
function fakeOps(dir: string, runs: LiveRun[], ack = true) {
  const panes = new Set(runs.map((run) => run.surface));
  const events: string[] = [];
  const ops: StopOps = {
    panePid: (pane) => panes.has(pane) ? 5000 + [...pane].reduce((sum, char) => sum + char.charCodeAt(0), 0) : undefined,
    escape: (pane) => {
      events.push(`escape:${pane}`);
      if (ack) writeRuntime(dir, runs.find((run) => run.surface === pane)!.id, "settled", {});
    },
    close: (pane) => { events.push(`close:${pane}`); panes.delete(pane); },
    processes: () => [...panes].map((pane) => ({ pid: ops.panePid(pane)!, ppid: 1,
      pgid: ops.panePid(pane)!, state: "S", started: "original pane identity" })),
    kill: (pid, signal) => { events.push(`${signal}:${pid}`); },
  };
  return { ops, events, panes };
}

describe("subagent stop runtime", () => {
  it("discovers only descendants through finished ancestors and rejects invalid run paths", () => {
    const dir = temp();
    try {
      for (const entry of [run("a"), run("b", "a"), run("c", "b"), run("other", "else")]) writeRuntime(dir, entry.id, "json", entry);
      writeRuntime(dir, "a", "finished", {});
      assert.deepEqual(descendants(readLiveRuns(dir), "a").map((run) => run.id), ["b", "c"]);
      assert.deepEqual(descendants(readLiveRuns(dir), "root").map((run) => run.id), ["a", "b", "c"]);
      markStop(dir, "a");
      const first = readFileSync(runtimeFile(dir, "a", "stop"), "utf8");
      markStop(dir, "a");
      assert.equal(readFileSync(runtimeFile(dir, "a", "stop"), "utf8"), first);
      assert.equal(isStopping(dir, "c"), true);
      assert.equal(isStopping(dir, "other"), false);
      assert.throws(() => runtimeFile(dir, "../outside"), /Invalid/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("refuses stale records from a different tmux server before marking or signalling", () => {
    const dir = temp();
    try {
      const a = { ...run("stale"), tmux: "/different/socket,999999" };
      writeRuntime(dir, a.id, "json", a);
      const { ops, events } = fakeOps(dir, [a]);
      assert.throws(() => stopSubtree(dir, a, ops), /different tmux server/);
      assert.equal(isStopping(dir, a.id), false);
      assert.deepEqual(events, []);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("a resumed run uses a fresh cancellation scope despite sharing name and transcript", () => {
    const dir = temp();
    try {
      const old = run("old", "root", "worker"), resumed = { ...old, id: "resumed" };
      for (const entry of [old, resumed]) writeRuntime(dir, entry.id, "json", entry);
      markStop(dir, old.id);
      writeRuntime(dir, old.id, "outcome", { status: "stopped", forced: false, errors: [] });
      assert.equal(isStopping(dir, old.id), true);
      assert.equal(isStopping(dir, resumed.id), false);
      assert.equal(stopOutcome(dir, resumed.id), undefined);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("marks the entire subtree before Escape, waits for ack, then closes leaf first; repeat is idempotent", async () => {
    const dir = temp();
    try {
      const a = run("a"), b = run("b", "a"), other = run("other");
      for (const entry of [a, b, other]) writeRuntime(dir, entry.id, "json", entry);
      const { ops, events, panes } = fakeOps(dir, [a, b, other]);
      const escape = ops.escape;
      ops.escape = (pane) => {
        assert.equal(isStopping(dir, b.id), true);
        assert.equal(isStopping(dir, other.id), false);
        assert.equal(events.some((event) => event.startsWith("close:")), false);
        escape(pane);
      };
      const [outcome, duplicate] = await Promise.all([stopSubtree(dir, a, ops), stopSubtree(dir, a, ops)]);
      assert.equal(outcome.status, "stopped");
      assert.equal(outcome.forced, false);
      assert.deepEqual(duplicate, outcome);
      assert.deepEqual(events, ["escape:%a", "escape:%b", "close:%b", "close:%a"]);
      assert.equal(panes.has("%other"), true);
      const eventCount = events.length;
      assert.deepEqual(await stopSubtree(dir, a, ops), outcome);
      assert.equal(events.length, eventCount);
      assert.deepEqual(stopOutcome(dir, b.id), outcome);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("discovers a launch racing cancellation and makes ancestor stop visible immediately", async () => {
    const dir = temp();
    try {
      const a = run("a"), b = run("b", "a");
      writeRuntime(dir, a.id, "json", a);
      const { ops, events } = fakeOps(dir, [a, b]);
      const escape = ops.escape;
      ops.escape = (pane) => {
        escape(pane);
        if (pane === a.surface) {
          writeRuntime(dir, b.id, "json", b);
          assert.equal(isStopping(dir, b.id), true);
        }
      };
      const outcome = await stopSubtree(dir, a, ops);
      assert.equal(outcome.status, "stopped");
      assert.ok(events.includes("escape:%b"));
      assert.ok(events.includes("close:%b"));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("traverses finished ancestors without touching historical panes or completed results", async () => {
    const dir = temp();
    try {
      const a = run("a"), old = run("old", "a"), child = run("child", "old");
      for (const entry of [a, old, child]) writeRuntime(dir, entry.id, "json", entry);
      writeRuntime(dir, old.id, "finished", {});
      const { ops, events, panes } = fakeOps(dir, [a, old, child]);
      assert.equal((await stopSubtree(dir, a, ops)).status, "stopped");
      assert.deepEqual(events, ["escape:%a", "escape:%child", "close:%child", "close:%a"]);
      assert.equal(panes.has(old.surface), true);
      assert.equal(stopOutcome(dir, old.id), undefined);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("never adopts an unrelated recycled PID when the initial pane snapshot missed the root", async () => {
    const dir = temp();
    try {
      const a = run("missing-root");
      writeRuntime(dir, a.id, "json", a);
      const { ops, events } = fakeOps(dir, [a]);
      const pid = ops.panePid(a.surface)!;
      let snapshots = 0;
      ops.processes = () => ++snapshots === 1 ? [] : [
        { pid, ppid: 1, pgid: pid, state: "S", started: "unrelated new occupant" },
        { pid: pid + 1, ppid: pid, pgid: pid, state: "S", started: "unrelated child" },
      ];
      const outcome = await stopSubtree(dir, a, ops);
      assert.equal(outcome.status, "stop_failed");
      assert.match(outcome.errors.join("\n"), /initial snapshot/);
      assert.ok(snapshots > 1, "the unrelated occupant appeared in later snapshots");
      assert.equal(events.some((event) => event.startsWith("SIG")), false, "neither unrelated process may be signalled");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("propagates failed descendant cleanup through finished metadata rather than claiming ancestor success", async () => {
    const dir = temp();
    try {
      const a = run("ancestor"), b = run("failed-child", a.id), c = run("live-grandchild", b.id);
      for (const entry of [a, b, c]) writeRuntime(dir, entry.id, "json", entry);
      const failed = { status: "stop_failed" as const, forced: true, errors: ["tool process still alive"] };
      writeRuntime(dir, b.id, "finished", {});
      writeRuntime(dir, b.id, "outcome", failed);
      const { ops, panes, events } = fakeOps(dir, [a, b, c]);
      const outcome = await stopSubtree(dir, a, ops);
      assert.equal(outcome.status, "stop_failed");
      assert.match(outcome.errors.join("\n"), /failed-child.*tool process still alive/);
      assert.equal(panes.has(b.surface), true, "failed cleanup is preserved, not silently reported as stopped");
      assert.equal(panes.has(c.surface), false, "discovery still traverses the failed ancestor");
      assert.deepEqual(stopOutcome(dir, b.id), failed);
      const count = events.length;
      assert.deepEqual(await stopSubtree(dir, a, ops), outcome);
      assert.equal(events.length, count);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("records an idempotent subtree outcome for a finished selected ancestor with live descendants", async () => {
    const dir = temp();
    try {
      const a = run("finished-selected"), b = run("active-child", a.id);
      for (const entry of [a, b]) writeRuntime(dir, entry.id, "json", entry);
      writeRuntime(dir, a.id, "finished", {});
      const { ops, events, panes } = fakeOps(dir, [a, b]);
      const outcome = await stopSubtree(dir, a, ops);
      assert.equal(outcome.status, "stopped");
      assert.deepEqual(events, ["escape:%active-child", "close:%active-child"]);
      assert.equal(panes.has(a.surface), true, "the historical ancestor's pane must not be targeted");
      assert.deepEqual(await stopSubtree(dir, a, ops), outcome);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("retains a resumable header if Pi was cancelled before its first transcript flush", async () => {
    const dir = temp();
    try {
      const a = { ...run("a"), sessionFile: join(dir, "fresh.jsonl"), cwd: "/original/cwd" };
      writeRuntime(dir, a.id, "json", a);
      writeFileSync(a.sessionFile + ".loadout.json", "{}");
      const { ops } = fakeOps(dir, [a]);
      assert.equal((await stopSubtree(dir, a, ops)).status, "stopped");
      const header = JSON.parse(readFileSync(a.sessionFile, "utf8"));
      assert.equal(header.type, "session");
      assert.equal(header.cwd, "/original/cwd");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("includes separate process-group bash and retained descendants in POSIX process snapshots", () => {
    const table = parseProcessTable("100 1 100 S Mon Nov 23 01:02:03 2026\n101 100 100 S Mon Nov 23 01:02:04 2026\n102 101 102 S Mon Nov 23 01:02:05 2026\n103 102 102 S Mon Nov 23 01:02:06 2026\n999 1 999 S Mon Nov 23 01:02:07 2026\n");
    assert.deepEqual(processDescendants(table, new Set([100])).map((row) => row.pid), [100, 101, 102, 103]);
    assert.equal(table[2].pgid, 102);
  });

  it("reports failed verification honestly instead of claiming stopped", async () => {
    const dir = temp();
    try {
      const a = run("a");
      writeRuntime(dir, a.id, "json", a);
      const { ops } = fakeOps(dir, [a]);
      ops.processes = () => { throw new Error("ps unavailable"); };
      const outcome = await stopSubtree(dir, a, ops);
      assert.equal(outcome.status, "stop_failed");
      assert.ok(outcome.errors.includes("ps unavailable"));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("child settlement acknowledgement", () => {
  it("requires idle tools/compaction and blocks new input without asking the model to stop", () => {
    const dir = temp();
    const previous = { dir: process.env.PI_SUBAGENT_RUNTIME_DIR, id: process.env.PI_SUBAGENT_ID };
    const interval = globalThis.setInterval, clear = globalThis.clearInterval, now = Date.now;
    try {
      process.env.PI_SUBAGENT_RUNTIME_DIR = dir;
      process.env.PI_SUBAGENT_ID = "child";
      const callbacks = new Map<string, Function>();
      let tick: Function = () => {}, time = 10000, idle = true, pendingMessages = false;
      const entries: any[] = [];
      Date.now = () => time;
      globalThis.setInterval = ((fn: Function) => { tick = fn; return { unref() {} }; }) as any;
      globalThis.clearInterval = (() => {}) as any;
      subagentDone({ on(event: string, fn: Function) { callbacks.set(event, fn); }, registerTool() {}, registerShortcut() {}, getAllTools() { return []; } } as any);
      callbacks.get("session_start")!({}, { isIdle: () => idle, hasPendingMessages: () => pendingMessages,
        sessionManager: { getEntries: () => entries }, ui: { setWidget() {} } });
      markStop(dir, "child");
      tick(); time += 300; tick();
      assert.ok(readRuntime(dir, "child", "settled"));
      callbacks.get("tool_execution_start")!({ toolCallId: "bash", toolName: "bash" });
      tick(); time += 300; tick();
      assert.equal(readRuntime(dir, "child", "settled"), undefined, "active bash must settle first");
      callbacks.get("tool_execution_end")!({ toolCallId: "bash", toolName: "bash" });
      idle = false; tick(); time += 300; tick();
      assert.equal(readRuntime(dir, "child", "settled"), undefined);
      idle = true;
      callbacks.get("session_before_compact")!();
      tick(); time += 300; tick();
      assert.equal(readRuntime(dir, "child", "settled"), undefined, "legacy isIdle is not enough during compaction");
      callbacks.get("session_compact_failed")!();
      tick(); time += 300; tick();
      assert.ok(readRuntime(dir, "child", "settled"));
      callbacks.get("user_bash")!({ command: "sleep 1" });
      callbacks.get("user_bash")!({ command: "sleep 1" });
      tick(); time += 300; tick();
      assert.equal(readRuntime(dir, "child", "settled"), undefined);
      entries.push({ id: "bash1", type: "message", message: { role: "bashExecution", command: "sleep 1", timestamp: time } });
      tick(); time += 300; tick();
      assert.equal(readRuntime(dir, "child", "settled"), undefined, "one result cannot settle two user bash operations");
      entries.push({ id: "bash2", type: "message", message: { role: "bashExecution", command: "sleep 1", timestamp: time } });
      tick(); time += 300; tick();
      assert.ok(readRuntime(dir, "child", "settled"));
      pendingMessages = true; tick(); time += 300; tick();
      assert.equal(readRuntime(dir, "child", "settled"), undefined, "legacy idle must also have an empty message queue");
      assert.deepEqual(callbacks.get("input")!(), { action: "handled" });
      assert.equal(callbacks.get("tool_call")!({ toolCallId: "late", toolName: "bash" }).block, true);
      callbacks.get("session_shutdown")!({ reason: "quit" });
    } finally {
      globalThis.setInterval = interval; globalThis.clearInterval = clear; Date.now = now;
      if (previous.dir === undefined) delete process.env.PI_SUBAGENT_RUNTIME_DIR; else process.env.PI_SUBAGENT_RUNTIME_DIR = previous.dir;
      if (previous.id === undefined) delete process.env.PI_SUBAGENT_ID; else process.env.PI_SUBAGENT_ID = previous.id;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("stop tool and completion semantics", () => {
  it("exercises real spawn/resume dispatch boundaries and public finished-ancestor stops in isolation", () => {
    const output = execFileSync(process.execPath, ["--experimental-test-module-mocks",
      fileURLToPath(new URL("./fixtures/stop-boundaries.ts", import.meta.url))], {
      encoding: "utf8", timeout: 15000, stdio: "pipe",
    });
    assert.match(output, /real completion counts passed/);
  });

  function setup(dir: string) {
    const tools: any[] = [], commands: any[] = [], messages: any[] = [];
    const pi = { on() {}, registerTool(tool: any) { tools.push(tool); }, registerCommand(name: string, command: any) { commands.push({ name, ...command }); }, registerMessageRenderer() {},
      sendMessage(message: any, options: any) { messages.push({ message, options }); }, getAllTools() { return []; } };
    extension(pi as any);
    const ctx = { cwd: dir, sessionManager: { getSessionFile: () => join(dir, "parent.jsonl"), getSessionDir: () => dir, getSessionId: () => "parent" } };
    const runtime = __test__.ensureRuntime(ctx);
    return { tools, commands, messages, pi, ctx, runtime, parentId: process.env.PI_SUBAGENT_ID ?? "root-parent" };
  }
  it("registers separate stop/tree surfaces without changing definitions-list tool", () => {
    const dir = temp();
    try {
      const { tools, commands } = setup(dir);
      assert.ok(tools.find((tool) => tool.name === "subagent_stop"));
      assert.ok(tools.find((tool) => tool.name === "subagents_list"));
      assert.ok(commands.find((command) => command.name === "subagents"));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("refuses ambiguous descendant names and names outside its own tree", async () => {
    const dir = temp();
    try {
      const { tools, ctx, runtime, parentId } = setup(dir);
      for (const entry of [run("a", parentId, "same"), run("b", "a", "same"), run("outside", "unrelated", "foreign")]) writeRuntime(runtime, entry.id, "json", entry);
      const tool = tools.find((tool) => tool.name === "subagent_stop");
      await assert.rejects(tool.execute("test", { name: "same" }, undefined, undefined, ctx), /Ambiguous/);
      await assert.rejects(tool.execute("test", { name: "foreign" }, undefined, undefined, ctx), /No descendant/);
      assert.equal(existsSync(runtimeFile(runtime, "a", "stop")), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("the production watcher sends exactly one stopped wake to the surviving direct parent", async () => {
    const dir = temp();
    const previous = { runtime: process.env.PI_SUBAGENT_RUNTIME_DIR, id: process.env.PI_SUBAGENT_ID };
    try {
      const { ctx, runtime, parentId, pi, messages } = setup(dir);
      const a = run("wake-a", parentId), b = run("wake-b", a.id), c = run("wake-c", b.id);
      for (const entry of [a, b, c]) writeRuntime(runtime, entry.id, "json", entry);
      const { ops } = fakeOps(runtime, [a, b, c]);
      await stopSubtree(runtime, a, ops);
      const watchers: Promise<void>[] = [];
      process.env.PI_SUBAGENT_RUNTIME_DIR = runtime;
      for (const entry of [a, b, c]) {
        process.env.PI_SUBAGENT_ID = entry.parentId;
        __test__.ensureRuntime(ctx);
        const running = { ...entry, task: "task", interactive: false,
          statusState: createStatusState({ source: "pi", startTimeMs: Date.now() }) };
        __test__.runningSubagents.set(entry.id, running);
        watchers.push(__test__.startSubagentWatcher(pi as any, running));
      }
      await Promise.all(watchers);
      assert.equal(messages.length, 1);
      assert.equal(messages[0].message.details.name, a.name);
      assert.equal(messages[0].message.details.stop.status, "stopped");
      assert.deepEqual(messages[0].options, { triggerTurn: true, deliverAs: "steer" });
    } finally {
      if (previous.runtime === undefined) delete process.env.PI_SUBAGENT_RUNTIME_DIR; else process.env.PI_SUBAGENT_RUNTIME_DIR = previous.runtime;
      if (previous.id === undefined) delete process.env.PI_SUBAGENT_ID; else process.env.PI_SUBAGENT_ID = previous.id;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the live tree renders nested role/status/elapsed rows, fits narrow widths, and requires confirmation", async () => {
    const dir = temp();
    try {
      const { commands, ctx, runtime, parentId } = setup(dir);
      const a = { ...run("tree-a", parentId, "worker-wide-名字"), agent: "worker" };
      const b = { ...run("tree-b", a.id, "nested-scout"), agent: "scout" };
      for (const entry of [a, b]) writeRuntime(runtime, entry.id, "json", entry);
      let screens = 0, confirmations = 0;
      const command = commands.find((command) => command.name === "subagents");
      const interactive = { ...ctx, mode: "tui", hasUI: true, ui: {
        notify() {},
        confirm() { assert.fail("native confirmation must not replace the editor"); },
        async custom(factory: Function, options: any) {
          assert.equal(options.overlay, true);
          assert.equal(options.overlayOptions.anchor, "center");
          assert.equal(options.overlayOptions.width, 96);
          assert.equal(options.overlayOptions.maxHeight, "100%");
          assert.equal(options.overlayOptions.minWidth, undefined);
          let result: unknown;
          const terminal = { rows: 24 };
          const view = factory({ terminal, requestRender() {} }, { fg: (_: string, text: string) => text },
            { matches: (data: string, key: string) => data === key }, (value: unknown) => { result = value; });
          try {
            const lines = view.render(100);
            assert.match(lines[0], /^╭─+╮$/);
            for (const width of [1, 2, 3, 4, 12, 35, 40]) {
              for (const height of [8, 12, 24]) {
                terminal.rows = height;
                const narrow = view.render(width);
                assert.ok(narrow.every((line: string) => visibleWidth(line) <= width));
                assert.ok(narrow.length <= height);
                if (width === 40) assert.match(narrow.join("\n"), /Esc (Close|Cancel)/, "narrow modal keeps its Escape hint visible");
              }
            }
            if (++screens === 2) {
              confirmations++;
              assert.match(lines.join("\n"), /Stop subagent subtree/);
              assert.match(lines.join("\n"), /ALL its descendants/);
              assert.match(lines.join("\n"), /History is preserved/);
              assert.match(lines.join("\n"), /> Yes/);
              assert.equal(isStopping(runtime, a.id), false, "confirmation precedes all stop effects");
              view.handleInput("tui.select.down");
              assert.match(view.render(100).join("\n"), /> No/);
              view.handleInput("tui.select.confirm");
            } else {
              assert.match(lines.join("\n"), /worker-wide-名字.*\[worker\].*starting.*00:00/);
              assert.match(lines.join("\n"), /nested-scout.*\[scout\]/);
              view.handleInput(screens === 1 ? "tui.select.confirm" : "\u001b");
            }
            return result;
          } finally { view.dispose?.(); }
        },
      } };
      await command.handler("", interactive);
      assert.equal(confirmations, 1);
      assert.equal(isStopping(runtime, a.id), false);
      assert.equal(isStopping(runtime, b.id), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("keeps the selected row visible after resize and returns to the modal tree on Escape from confirmation", async () => {
    const dir = temp();
    try {
      const { commands, ctx, runtime, parentId } = setup(dir);
      const entries = Array.from({ length: 20 }, (_, i) => run(`page-${String(i).padStart(2, "0")}`, parentId));
      for (const entry of entries) writeRuntime(runtime, entry.id, "json", entry);
      let screens = 0;
      await commands.find((command) => command.name === "subagents").handler("", { ...ctx, mode: "tui", hasUI: true, ui: {
        notify() {},
        async custom(factory: Function, options: any) {
          assert.equal(options.overlay, true);
          assert.equal(options.overlayOptions.anchor, "center");
          const terminal = { rows: 24 };
          let result: unknown;
          const view = factory({ terminal, requestRender() {} }, { fg: (_: string, text: string) => text },
            { matches: (data: string, key: string) => data === key }, (value: unknown) => { result = value; });
          try {
            if (++screens === 1) {
              for (let i = 0; i < 19; i++) view.handleInput("tui.select.down");
              terminal.rows = 8;
              const lines = view.render(80);
              assert.ok(lines.length <= 8);
              assert.match(lines.join("\n"), /> .*page-19/);
              assert.match(lines.at(-2), /Esc Close/);
              view.handleInput("tui.select.confirm");
              assert.equal((result as LiveRun).id, "page-19");
            } else if (screens === 2) {
              assert.match(view.render(80).join("\n"), /Cancel "page-19"/);
              view.handleInput("\u001b");
              assert.equal(result, false);
            } else {
              assert.match(view.render(80).join("\n"), /Active subagents/);
              view.handleInput("\u001b");
            }
            return result;
          } finally { view.dispose?.(); }
        },
      } });
      assert.equal(screens, 3);
      for (const entry of entries) assert.equal(isStopping(runtime, entry.id), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("revalidates a selection that finishes while the confirmation is open", async () => {
    const dir = temp();
    try {
      const { commands, ctx, runtime, parentId } = setup(dir);
      const a = run("finished-during-confirm", parentId);
      writeRuntime(runtime, a.id, "json", a);
      let screens = 0;
      await commands.find((command) => command.name === "subagents").handler("", { ...ctx, mode: "tui", hasUI: true, ui: {
        notify(text: string, level: string) { assert.match(text, /already finished/); assert.equal(level, "info"); },
        confirm() { assert.fail("confirmation must remain modal"); },
        async custom(factory: Function, options: any) {
          assert.equal(options.overlay, true);
          assert.equal(options.overlayOptions.anchor, "center");
          let result: unknown;
          const view = factory({ terminal: { rows: 24 }, requestRender() {} }, { fg: (_: string, text: string) => text },
            { matches: (data: string, key: string) => data === key }, (value: unknown) => { result = value; });
          try {
            if (++screens === 2) writeRuntime(runtime, a.id, "finished", {});
            view.handleInput(screens <= 2 ? "tui.select.confirm" : "tui.select.cancel");
            return result;
          } finally { view.dispose?.(); }
        },
      } });
      assert.equal(isStopping(runtime, a.id), false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("stopped completion never promotes stale assistant text, including presentation used by resumes", async () => {
    const dir = temp();
    try {
      const { runtime, parentId, pi, messages } = setup(dir);
      const entry = { ...run("stopped", parentId), sessionFile: join(dir, "stopped.jsonl") };
      writeFileSync(entry.sessionFile, JSON.stringify({ type: "session", id: "session-stopped", version: 3 }) + "\n" +
        JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "STALE ASSISTANT TEXT" }] } }) + "\n");
      writeRuntime(runtime, entry.id, "json", entry);
      markStop(runtime, entry.id);
      writeRuntime(runtime, entry.id, "outcome", { status: "stopped", forced: true, errors: [] });
      const running = { ...entry, task: "task", interactive: false, statusState: createStatusState({ source: "pi", startTimeMs: Date.now() }) };
      __test__.runningSubagents.set(entry.id, running);
      await __test__.startSubagentWatcher(pi as any, running, { entryCountBefore: 0, sessionId: "session-stopped" });
      assert.equal(messages.length, 1);
      assert.equal(messages[0].message.details.stop.status, "stopped");
      const presentation = messages[0].message.content;
      assert.doesNotMatch(presentation, /STALE ASSISTANT TEXT/);
      assert.match(presentation, /stopped.*forced fallback/);
      assert.doesNotMatch(presentation, /completed|failed \(exit/);
      assert.equal(readRuntime(runtime, entry.id, "finished") !== undefined, true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
