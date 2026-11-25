/** No model calls. Real tmux Escape + Pi's actual bash tool, and a hung child
 * whose active bash lives in a separate group and ignores cancellation/TERM.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isMuxAvailable, surfacePid, pollForExit, closeSurface, shellEscape } from "../../pi-extension/subagents/tmux.ts";
import { stopSubtree, processTable, processDescendants, type ProcessInfo } from "../../pi-extension/subagents/stop.ts";
import { writeRuntime, type LiveRun } from "../../pi-extension/subagents/runtime.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for stop fixture");
    await sleep(50);
  }
}

describe("subagent stop [real tmux, no LLM]", { skip: !isMuxAvailable(), timeout: 30000 }, () => {
  for (const mode of ["cooperative", "ignores-abort", "hung-event-loop"] as const) {
    const cooperative = mode === "cooperative";
    it(cooperative ? "Escape cancels Pi's built-in bash before pane closure" :
      mode === "ignores-abort" ? "bounded fallback kills ignoring active bash in its separate process group" :
      "external fallback terminates a hung Pi event loop and its active bash", async () => {
      const dir = mkdtempSync(join(tmpdir(), "pi-stop-integration-"));
      let pane: string | undefined;
      let bashPid: number | undefined;
      let observedTools: ProcessInfo[] = [];
      try {
        const fixture = join(dir, "fixture.mjs");
        const grandchild = join(dir, "grandchild.mjs");
        writeFileSync(grandchild, `
          import { spawn } from 'node:child_process';
          import { writeFileSync } from 'node:fs';
          const dir = ${JSON.stringify(dir)};
          if (${!cooperative}) {
            process.on('SIGTERM', () => {}); process.on('SIGHUP', () => {});
          }
          writeFileSync(dir + '/grandchild-pid', String(process.pid));
          const child = spawn(process.execPath, ['-e',
            ${JSON.stringify(`${!cooperative ? "process.on('SIGTERM',()=>{});process.on('SIGHUP',()=>{});" : ""}setInterval(()=>{},1000);`)}
          ], { detached: ${!cooperative}, stdio: 'ignore' });
          writeFileSync(dir + '/great-grandchild-pid', String(child.pid));
          setInterval(() => {}, 1000);
        `);
        const bashTool = resolve("node_modules/@mariozechner/pi-coding-agent/dist/core/tools/bash.js");
        writeFileSync(fixture, `
          import { createBashTool } from ${JSON.stringify(bashTool)};
          import { writeFileSync } from 'node:fs';
          const dir = ${JSON.stringify(dir)};
          const abort = new AbortController();
          process.stdin.setRawMode(true);
          process.stdin.resume();
          process.stdin.on('data', data => {
            if (data.includes(27)) {
              writeFileSync(dir + '/escape', 'real Escape');
              if (${cooperative}) abort.abort();
            }
          });
          const command = ${JSON.stringify(`echo $$ > ${shellEscape(join(dir, "bash-pid"))}; ${cooperative ? "" : "trap '' TERM HUP; "}${shellEscape(process.execPath)} ${shellEscape(grandchild)} & while :; do sleep 1; done`)};
          if (${mode === "hung-event-loop"}) {
            process.on('SIGTERM', () => {});
            setTimeout(() => { writeFileSync(dir + '/hung', 'event loop blocked'); while (true) {} }, 100);
          }
          try { await createBashTool(dir).execute('test-bash', { command }, abort.signal); }
          catch {}
          writeFileSync(dir + '/run.settled', '{}');
          writeFileSync(dir + '/tool-settled', 'bash promise settled');
        `);
        pane = execFileSync("tmux", ["new-window", "-d", "-P", "-F", "#{pane_id}", "-n", "pi-stop-test", `${shellEscape(process.execPath)} ${shellEscape(fixture)}`], { encoding: "utf8" }).trim();
        await until(() => existsSync(join(dir, "bash-pid")));
        await until(() => existsSync(join(dir, "great-grandchild-pid")));
        if (mode === "hung-event-loop") await until(() => existsSync(join(dir, "hung")));
        bashPid = +readFileSync(join(dir, "bash-pid"), "utf8").trim();
        const grandchildPid = +readFileSync(join(dir, "grandchild-pid"), "utf8").trim();
        const greatGrandchildPid = +readFileSync(join(dir, "great-grandchild-pid"), "utf8").trim();
        const table = processTable();
        observedTools = processDescendants(table, new Set([bashPid]));
        const before = table.find((row) => row.pid === bashPid)!;
        assert.ok(observedTools.some((row) => row.pid === grandchildPid && row.ppid === bashPid));
        assert.ok(observedTools.some((row) => row.pid === greatGrandchildPid && row.ppid === grandchildPid));
        if (!cooperative) assert.equal(table.find((row) => row.pid === greatGrandchildPid)?.pgid, greatGrandchildPid,
          "the great-grandchild also escaped bash's process group while remaining in its ancestry");
        assert.ok(before, "active bash exists before cancellation");
        assert.equal(before.pgid, bashPid, "Pi bash is in a separate group");
        const run: LiveRun = { id: "run", parentId: "parent", name: "fixture", surface: pane, sessionFile: join(dir, "session.jsonl"), startTime: Date.now() };
        writeRuntime(dir, run.id, "json", run);
        const start = Date.now();
        const outcome = await stopSubtree(dir, run);
        assert.equal(outcome.status, "stopped", outcome.errors.join("; "));
        assert.equal(outcome.forced, !cooperative);
        assert.ok(Date.now() - start < 15000, "stop is bounded");
        if (mode !== "hung-event-loop") assert.ok(existsSync(join(dir, "escape")), "actual Escape reached terminal stdin");
        if (cooperative) assert.ok(existsSync(join(dir, "tool-settled")), "tool settled before closure");
        assert.equal(surfacePid(pane), undefined);
        const after = processTable();
        for (const tool of observedTools) {
          assert.equal(after.some((row) => row.pid === tool.pid && row.started === tool.started && !row.state.startsWith("Z")), false,
            `tool descendant ${tool.pid} must not survive merely because its bash leader exited`);
        }
      } finally {
        if (pane && surfacePid(pane)) closeSurface(pane);
        const remaining = processTable();
        for (const tool of [...observedTools].reverse()) {
          if (remaining.some((row) => row.pid === tool.pid && row.started === tool.started)) {
            try { process.kill(tool.pid, "SIGKILL"); } catch {}
          }
        }
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("uses the real installed Pi Escape path and observes user bash settlement without a model call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-stop-host-"));
    let pane: string | undefined;
    let bashPid: number | undefined;
    try {
      const sessionFile = join(dir, "session.jsonl");
      const activityFile = join(dir, "activity.json");
      // Pi lazily creates brand-new transcripts until a conversation exists.
      // An existing header lets this no-model fixture persist !bash history.
      writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: "stop-host",
        timestamp: new Date().toISOString(), cwd: dir }) + "\n");
      const doneExtension = resolve("pi-extension/subagents/subagent-done.ts");
      const command = `cd ${shellEscape(dir)} && PI_SUBAGENT_RUNTIME_DIR=${shellEscape(dir)} PI_SUBAGENT_ID=host PI_SUBAGENT_SESSION=${shellEscape(sessionFile)} PI_SUBAGENT_ACTIVITY_FILE=${shellEscape(activityFile)} pi -ne -e ${shellEscape(doneExtension)} --session ${shellEscape(sessionFile)}`;
      pane = execFileSync("tmux", ["new-window", "-d", "-P", "-F", "#{pane_id}", "-n", "pi-stop-host", command], { encoding: "utf8" }).trim();
      await until(() => existsSync(activityFile));
      const run: LiveRun = { id: "host", parentId: "parent", name: "real-pi", surface: pane, sessionFile, activityFile, startTime: Date.now() };
      writeRuntime(dir, run.id, "json", run);
      execFileSync("tmux", ["send-keys", "-t", pane, "-l", `!echo $$ > ${shellEscape(join(dir, "bash-pid"))}; while :; do sleep 1; done`]);
      execFileSync("tmux", ["send-keys", "-t", pane, "Enter"]);
      await until(() => existsSync(join(dir, "bash-pid")));
      bashPid = +readFileSync(join(dir, "bash-pid"), "utf8").trim();
      const outcome = await stopSubtree(dir, run);
      assert.equal(outcome.status, "stopped", outcome.errors.join("; "));
      assert.ok(existsSync(join(dir, "host.settled")), "the actual Pi cancellation path acknowledged settlement");
      const bashResult = readFileSync(sessionFile, "utf8").trim().split("\n").map((line) => JSON.parse(line))
        .find((entry) => entry.message?.role === "bashExecution");
      assert.equal(bashResult?.message.cancelled, true, "Escape cancelled user bash before pane closure");
      // A lingering terminal shell can still need external cleanup after its
      // operation settled, depending on shell startup/exit hooks on this host.
      assert.equal(surfacePid(pane), undefined);
    } finally {
      if (pane && surfacePid(pane)) closeSurface(pane);
      if (bashPid) { try { process.kill(-bashPid, "SIGKILL"); } catch {} }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the installed Pi host centers the tree and confirmation over the conversation and handles resize/Escape", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-subagents-modal-"));
    let pane: string | undefined;
    try {
      const sessionFile = join(dir, "session.jsonl");
      writeFileSync(sessionFile, JSON.stringify({ type: "session", version: 3, id: "modal-host",
        timestamp: new Date().toISOString(), cwd: dir }) + "\n");
      const fixture = join(dir, "modal.ts");
      // Avoid user packages, credentials and startup banners in either Pi lineage.
      mkdirSync(join(dir, "agent"));
      writeFileSync(join(dir, "agent", "settings.json"), JSON.stringify({ quietStartup: true }));
      writeFileSync(fixture, `
        import extension, { __test__ } from ${JSON.stringify(resolve("pi-extension/subagents/index.ts"))};
        import { writeRuntime } from ${JSON.stringify(resolve("pi-extension/subagents/runtime.ts"))};
        import { writeFileSync } from 'node:fs';
        export default function(pi) {
          extension(pi);
          pi.on('session_start', (_event, ctx) => {
            const runtime = __test__.ensureRuntime(ctx);
            for (const [id, parentId, name] of [
              ['modal-a', 'modal-parent', 'modal-worker'], ['modal-b', 'modal-a', 'nested-scout']
            ]) writeRuntime(runtime, id, 'json', { id, parentId, name, agent: 'scout',
              surface: '%not-a-real-pane', sessionFile: ${JSON.stringify(sessionFile)}, startTime: Date.now() });
            pi.sendMessage({ customType: 'modal-proof', content: 'CONVERSATION-BEHIND-MODAL', display: true });
            writeFileSync(${JSON.stringify(join(dir, "ready"))}, 'ready');
          });
        }
      `);
      const command = `cd ${shellEscape(dir)} && PI_OFFLINE=1 PI_CODING_AGENT_DIR=${shellEscape(join(dir, "agent"))} PI_SUBAGENT_RUNTIME_DIR=${shellEscape(dir)} PI_SUBAGENT_ID=modal-parent pi -ne -e ${shellEscape(fixture)} --session ${shellEscape(sessionFile)}`;
      pane = execFileSync("tmux", ["new-window", "-d", "-P", "-F", "#{pane_id}", "-n", "pi-modal-test", command], { encoding: "utf8" }).trim();
      const resize = (width: number, height: number) => execFileSync("tmux", ["resize-window", "-t", pane!, "-x", String(width), "-y", String(height)]);
      const screen = () => execFileSync("tmux", ["capture-pane", "-p", "-t", pane!], { encoding: "utf8" });
      const key = (value: string) => execFileSync("tmux", ["send-keys", "-t", pane!, value]);
      const assertCentered = (width: number, height: number) => {
        const lines = screen().split("\n");
        const top = lines.findIndex((line) => line.includes("╭"));
        const bottom = lines.findIndex((line) => line.includes("╰"));
        const modalWidth = Math.min(96, width - 2);
        assert.ok(top >= 0 && bottom > top, "both modal borders are visible");
        assert.equal(lines[top].indexOf("╭"), Math.floor((width - modalWidth) / 2));
        assert.equal(top, Math.floor((height - (bottom - top + 1)) / 2));
        assert.equal(lines[top].indexOf("╮") - lines[top].indexOf("╭") + 1, modalWidth);
      };
      resize(120, 30);
      await until(() => existsSync(join(dir, "ready")) && screen().includes("CONVERSATION-BEHIND-MODAL"));
      execFileSync("tmux", ["send-keys", "-t", pane, "-l", "/subagents"]);
      key("Enter");
      await until(() => screen().includes("Active subagents"));
      assertCentered(120, 30);
      assert.match(screen(), /CONVERSATION-BEHIND-MODAL/, "conversation stays visible, not replaced by the modal");
      key("Down");
      key("Enter");
      await until(() => screen().includes("Stop subagent subtree?"));
      assertCentered(120, 30);
      assert.match(screen(), /Cancel "nested-scout"/);
      key("Escape");
      await until(() => screen().includes("Active subagents"));
      resize(40, 12);
      await until(() => screen().includes("╭" + "─".repeat(36) + "╮"));
      assertCentered(40, 12);
      key("Enter");
      await until(() => screen().includes("Stop subagent subtree?"));
      assertCentered(40, 12);
      assert.match(screen(), /> Yes/);
      assert.match(screen(), /Esc Cancel/);
      key("Escape");
      await until(() => screen().includes("Active subagents"));
      key("Escape");
      await until(() => !screen().includes("╭"));
      for (const id of ["modal-a", "modal-b"]) assert.equal(existsSync(join(dir, `${id}.stop`)), false);
    } catch (error) {
      let lastScreen = "(pane unavailable)";
      try { lastScreen = execFileSync("tmux", ["capture-pane", "-p", "-t", pane!], { encoding: "utf8" }); } catch {}
      throw new Error(`${error instanceof Error ? error.message : error}\nLast screen:\n${lastScreen}`, { cause: error });
    } finally {
      if (pane && surfacePid(pane)) closeSurface(pane);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a vanished pane terminates its watcher with an honest failure", async () => {
    const pane = execFileSync("tmux", ["new-window", "-d", "-P", "-F", "#{pane_id}", "-n", "pi-stop-missing", "sleep 30"], { encoding: "utf8" }).trim();
    closeSurface(pane);
    const result = await pollForExit(pane, new AbortController().signal, { interval: 50 });
    assert.equal(result.reason, "error");
    assert.match(result.errorMessage!, /disappeared/);
  });
});
