import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(import.meta.dirname, '..');
const temp = mkdtempSync(join(tmpdir(), 'pi-subagents-pack-'));
function tree(path) {
  return readdirSync(join(root, path), { withFileTypes: true }).flatMap((entry) => {
    const child = `${path}/${entry.name}`;
    assert.ok(!entry.isSymbolicLink(), `Runtime symlink is not allowed: ${child}`);
    return entry.isDirectory() ? tree(child) : [child];
  });
}
try {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json')));
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json')));
  assert.equal(pkg.name, '@ivannovr/pi-interactive-subagents');
  assert.equal(lock.name, pkg.name);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].name, pkg.name);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(pkg.repository.url, 'git+https://github.com/IvanNovR/pi-interactive-subagents.git');
  assert.equal(pkg.license, 'MIT');
  assert.match(readFileSync(join(root, 'LICENSE'), 'utf8'), /Copyright \(c\) 2026 HazAT/);
  assert.ok(pkg.keywords.includes('pi-package'));
  assert.deepEqual(pkg.pi.extensions, ['./pi-extension/subagents/index.ts']);
  assert.equal(pkg.publishConfig?.registry, undefined, 'Both registries must remain selectable');
  for (const name of ['@mariozechner/pi-coding-agent', '@mariozechner/pi-tui', '@sinclair/typebox']) {
    assert.equal(pkg.peerDependencies[name], '*');
    assert.equal(pkg.dependencies?.[name], undefined, 'Do not bundle host-provided peers');
  }
  assert.deepEqual(lock.packages[''].peerDependencies, pkg.peerDependencies);
  assert.deepEqual(lock.packages[''].devDependencies, pkg.devDependencies);
  const [pack] = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', temp], { cwd: root, encoding: 'utf8' }));
  assert.equal(pack.name, pkg.name);
  assert.equal(pack.version, pkg.version);
  const repeatDir = join(temp, 'repeat');
  mkdirSync(repeatDir);
  const [repeat] = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', repeatDir], { cwd: root, encoding: 'utf8' }));
  assert.equal(repeat.integrity, pack.integrity, 'Repeated packing must produce identical bytes for retry safety');
  const required = [
    'package.json', 'README.md', 'LICENSE', 'CHANGELOG.md', 'config.json.example', 'docs/RELEASING.md',
    ...tree('pi-extension/subagents'),
    ...readdirSync(join(root, 'agents')).filter((name) => name.endsWith('.md')).map((name) => `agents/${name}`),
  ];
  assert.deepEqual(pack.files.map(({ path }) => path).sort(), required.sort(), 'Tarball must contain all and only curated runtime/documentation files');
  for (const { path } of pack.files) {
    assert.match(path, /^(?:package\.json|README\.md|LICENSE|CHANGELOG\.md|config\.json\.example|docs\/RELEASING\.md|agents\/[^/]+\.md|pi-extension\/subagents\/(?:[^/]+\.ts|tools\/[^/]+\.ts|plugin\/(?:\.claude-plugin\/plugin\.json|hooks\/(?:hooks\.json|on-stop\.sh))))$/, `Unexpected runtime/documentation file: ${path}`);
  }
  for (const name of ['scout', 'researcher', 'worker']) assert.ok(required.includes(`agents/${name}.md`));
  assert.ok(required.includes('pi-extension/subagents/plugin/.claude-plugin/plugin.json'));
  const hook = pack.files.find(({ path }) => path === 'pi-extension/subagents/plugin/hooks/on-stop.sh');
  assert.ok(hook && (hook.mode & 0o111), 'Bundled stop hook must remain executable');

  const installed = join(temp, 'installed');
  mkdirSync(installed);
  execFileSync('npm', ['install', '--offline', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund', '--package-lock=false', join(temp, pack.filename)], { cwd: installed, stdio: 'inherit' });
  // Pi supplies these modules. Reuse locked host copies without downloading peers.
  for (const name of ['@mariozechner/pi-coding-agent', '@mariozechner/pi-tui', '@sinclair/typebox']) {
    const target = join(installed, 'node_modules', name);
    mkdirSync(resolve(target, '..'), { recursive: true });
    symlinkSync(join(root, 'node_modules', name), target, 'dir');
  }
  const hostRequire = createRequire(import.meta.resolve('@mariozechner/pi-coding-agent'));
  const jitiURL = pathToFileURL(hostRequire.resolve('@mariozechner/jiti')).href;
  const packageRoot = join(installed, 'node_modules', '@ivannovr', 'pi-interactive-subagents');
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { existsSync, mkdirSync, readFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { pathToFileURL } from 'node:url';
    const packageRoot = ${JSON.stringify(packageRoot)};
    const fixture = ${JSON.stringify(join(temp, 'fixture'))};
    mkdirSync(fixture);
    process.chdir(fixture);
    process.env.PI_CODING_AGENT_DIR = join(fixture, 'global');
    for (const name of Object.keys(process.env)) if (name.startsWith('PI_SUBAGENT_')) delete process.env[name];
    globalThis.fetch = () => { throw new Error('Package smoke must not access the network'); };
    const { createJiti } = await import(${JSON.stringify(jitiURL)});
    const jiti = createJiti(import.meta.url, { tryNative: false, moduleCache: false, fsCache: false });
    const module = await jiti.import(pathToFileURL(join(packageRoot, 'pi-extension/subagents/index.ts')).href);
    const tools = new Map(), commands = new Map(), handlers = new Map();
    const api = {
      on: (name, fn) => handlers.set(name, fn),
      registerTool: (tool) => tools.set(tool.name, tool),
      registerCommand: (name, command) => commands.set(name, command),
      registerMessageRenderer() {}, registerShortcut() {}, getAllTools: () => [],
    };
    module.default(api);
    assert.deepEqual([...tools.keys()].sort(), ['subagent', 'subagent_message', 'subagents_list']);
    assert.deepEqual([...commands.keys()].sort(), ['subagent', 'subagent-settings']);
    assert.ok(handlers.has('session_start') && handlers.has('session_shutdown'));
    const agents = module.__test__.discoverAgentDefinitions(fixture);
    assert.deepEqual(agents.map(({ name }) => name).sort(), ['researcher', 'scout', 'worker']);
    assert.ok(agents.every(({ source }) => source === 'package'));
    assert.ok(!existsSync(process.env.PI_CODING_AGENT_DIR), 'Discovery must not write user configuration');
    const status = await jiti.import(pathToFileURL(join(packageRoot, 'pi-extension/subagents/status.ts')).href);
    assert.equal(typeof status.loadStatusConfig().enabled, 'boolean');
    process.env.PI_SUBAGENT_SESSION = join(fixture, 'session.jsonl');
    const done = await jiti.import(pathToFileURL(join(packageRoot, 'pi-extension/subagents/subagent-done.ts')).href);
    done.default(api);
    assert.ok(tools.has('ask_question'));
    const safe = await jiti.import(pathToFileURL(join(packageRoot, 'pi-extension/subagents/tools/safe-bash.ts')).href);
    safe.default(api);
    assert.ok(tools.has('safe_bash'));
    const plugin = JSON.parse(readFileSync(join(packageRoot, 'pi-extension/subagents/plugin/.claude-plugin/plugin.json')));
    assert.equal(plugin.name, 'pi-auto-exit');
    // Registration/discovery only: never execute a tool, start Pi, or call a model.
  `], { cwd: installed, stdio: 'inherit' });
  console.log(`Tarball allowlist, metadata, offline installation and Mario Pi source registration/bundled-agent smoke passed (${pack.files.length} files).`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
