import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { legacyBoundary } from '../scripts/check-commits.mjs';

// Reuse the locked host's YAML parser, without adding a runtime dependency.
const hostRequire = createRequire(import.meta.resolve('@mariozechner/pi-coding-agent'));
const { parse } = hostRequire('yaml');
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const ci = parse(read('.github/workflows/ci.yml'));
const release = parse(read('.github/workflows/release.yml'));

test('first release uses initial-version, not a fabricated previous-release manifest', () => {
  const config = JSON.parse(read('release-please-config.json'));
  const manifest = JSON.parse(read('.release-please-manifest.json'));
  const pkg = JSON.parse(read('package.json'));
  assert.equal(config['release-type'], 'node');
  assert.equal(config.packages['.']['initial-version'], '1.0.0');
  assert.equal(config['release-as'], undefined);
  assert.equal(config.packages['.']['release-as'], undefined);
  assert.equal(config['bootstrap-sha'], legacyBoundary);
  assert.equal(config['include-component-in-tag'], false);
  assert.equal(config['include-v-in-tag'], true);
  if (!Object.hasOwn(manifest, '.')) {
    assert.deepEqual(manifest, {});
    assert.equal(pkg.version, '1.0.0');
  } else {
    // The first actual release PR is supposed to populate this field.
    assert.equal(manifest['.'], pkg.version);
  }
});

test('README introduces the project before concise scoped npm installation', () => {
  const readme = read('README.md');
  assert.match(readme, /^# pi-interactive-subagents\n/);
  const installation = readme.split('## Installation\n')[1]?.split('\n## ')[0];
  assert.ok(installation, 'Installation section must follow the introduction');
  assert.match(installation, /^\nRequires \*\*pi 0\.65\.0\*\* \(tested\).*\n\n```bash\npi install npm:@ivannovr\/pi-interactive-subagents\n```/);
  assert.match(installation, /```bash\ntmux new -A -s pi\npi\n```/);
  assert.match(installation, /https:\/\/github\.com\/tmux\/tmux\/wiki\/Installing/);
  assert.doesNotMatch(installation, /pending|unpublished|git:|\/absolute\/path/);
});

test('actions and development runtime are pinned', () => {
  for (const workflow of [ci, release]) {
    for (const job of Object.values(workflow.jobs)) {
      assert.equal(job['runs-on'], 'ubuntu-24.04');
      for (const step of job.steps) {
        if (step.uses) assert.match(step.uses, /^[\w-]+\/[\w-]+@[0-9a-f]{40}$/);
        if (step.uses?.startsWith('actions/checkout@')) assert.equal(step.with['persist-credentials'], false);
        if (step.uses?.startsWith('actions/setup-node@')) {
          assert.equal(step.with['node-version'], '24.21.0');
          assert.equal(step.with['package-manager-cache'], false);
        }
      }
    }
  }
});

test('CI is read-only, validates exact PR heads, and never runs paid integration tests', () => {
  assert.deepEqual(ci.permissions, { contents: 'read' });
  for (const job of Object.values(ci.jobs)) {
    assert.ok(Object.values(job.permissions ?? {}).every((level) => level === 'read'));
  }
  const source = ci.jobs.source.steps[0].run;
  assert.match(source, /\.head\.sha == \$sha/);
  assert.match(source, /test "\$WORKFLOW_SHA" = "\$EXPECTED_SHA"/);
  assert.match(source, /\.head\.repo\.full_name == \$repo and \.base\.ref == "main"/);
  for (const job of [ci.jobs.package, release.jobs.publish]) {
    const commands = job.steps.map((step) => step.run ?? '').join('\n');
    assert.match(commands, /npm ci/);
    assert.match(commands, /npm test/);
    assert.match(commands, /npm run check:package/);
    assert.doesNotMatch(commands, /test:integration|pi -|tmux new/);
  }
});

test('release and publication are independently main/environment gated', () => {
  assert.deepEqual(release.permissions, {});
  assert.deepEqual(release.on.push.branches, ['main']);
  assert.match(release.jobs.release.if, /github.ref == 'refs\/heads\/main'/);
  assert.match(release.jobs.release.if, /RELEASE_AUTOMATION_READY == 'true'/);
  assert.match(release.jobs.target.if, /RELEASE_AUTOMATION_READY == 'true'/);
  assert.match(release.jobs.target.if, /PUBLICATION_READY == 'true'/);
  assert.match(release.jobs.target.if, /github.ref == 'refs\/heads\/main'/);
  assert.match(release.jobs.target.if, /release_created == 'true'/);
  assert.match(release.jobs.target.if, /inputs.operation == 'retry'/);
  assert.equal(release.jobs.publish.environment, 'publication');
  assert.deepEqual(release.jobs.publish.permissions, { contents: 'read', 'id-token': 'write', packages: 'write' });
  assert.equal(release.concurrency['cancel-in-progress'], false);
  const commands = release.jobs.publish.steps.map((step) => step.run ?? '').join('\n');
  assert.match(commands, /git merge-base --is-ancestor HEAD refs\/remotes\/origin\/main/);
  assert.match(commands, /assert.equal\(`v\$\{p.version\}`, process.env.RELEASE_TAG\)/);
  assert.equal((commands.match(/npm pack --json/g) ?? []).length, 1);
  const npm = release.jobs.publish.steps.find((step) => step.name?.startsWith('Publish npm'));
  const github = release.jobs.publish.steps.find((step) => step.name?.startsWith('Publish GitHub'));
  assert.equal(npm.env.NODE_AUTH_TOKEN, undefined);
  assert.notEqual(npm.env.NPM_CONFIG_USERCONFIG, github.env.NPM_CONFIG_USERCONFIG);
  assert.equal(github.env.NODE_AUTH_TOKEN, '${{ github.token }}');
  assert.match(npm.run, /https:\/\/registry.npmjs.org/);
  assert.match(github.run, /https:\/\/npm.pkg.github.com/);
});
