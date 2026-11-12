# Maintainer release guide

## Current preparation and safety boundary

This checkout prepares the **first scoped release, 3.7.2 / v3.7.2**, of `@ivannovr/pi-interactive-subagents`. It does not assert that the package or tag exists. Preparation does not authorize committing, uploading, tagging, creating releases, changing remote settings, or publishing. Those are separate, explicitly approved phases.

The intended destinations are npm and GitHub Packages, using the same scoped name and exact tarball. The repository is `IvanNovR/pi-interactive-subagents`, default branch `main`. Mario Pi compatibility is retained; this work does not migrate dependencies to Earendil Pi. Preserve the MIT copyright notice for HazAT and README upstream attribution.

Once separately uploaded, CI is read-only. Release automation remains disabled unless `RELEASE_AUTOMATION_READY` is exactly `true`; registry work additionally requires `PUBLICATION_READY` exactly `true` and approval through the `publication` environment. Do not enable either variable during local preparation.

## Local verification (no model calls)

Use **Node 24.21.0 / npm 11.19.0**, matching the workflows:

```bash
npm ci
npm test
npm run check:package
npm run check:commits
```

`npm test` runs unit tests, the system-prompt smoke tests, mocked registry tests and release/commit-policy checks. `check:package` checks metadata and exact tarball contents, installs the tarball offline without peers or lifecycle scripts, and uses the locked Mario Pi host/Jiti loader to check installed TypeScript registration, bundled-agent discovery, config and plugin assets. Temporary fixture directories are removed. Neither command launches Pi/tmux sessions, executes agent tools, authenticates to a registry or calls model providers. Do not run the separate `test:integration` suite as part of unattended preparation or publication: it uses real Pi sessions and may incur provider costs.

All new commits and PR titles must be Conventional Commits, including bot/squash titles. Imported history through `c3e8b53c0754ae5ccc19fdab5a7481ec039bc2f7` is a verified exclusive boundary. The checker tests every new commit after that boundary (or after a newer push/PR base), and fails on unrelated history. It does not pretend legacy commits are conventional or reuse another project's exemption. Prefer squash merges with the checked title; default `Merge pull request ...` subjects do not satisfy this policy.

## Why the first release is exactly 3.7.2

The package and lockfile start at 3.7.2, while `.release-please-manifest.json` starts as **`{}`**: no previous scoped release is recorded. `release-please-config.json` sets the Node strategy's **`initial-version: "3.7.2"`**. With no previous release, release-please selects this initial version directly instead of applying a patch/minor bump. Its first release PR records 3.7.2 in the manifest and adds a versioned changelog entry; package/lock versions may remain unchanged.

**Do not seed the manifest with `{ ".": "3.7.2" }`.** That asserts 3.7.2 as a previous release baseline and can yield 3.7.3/3.8.0 instead. Do not add a persistent `release-as`, a `Release-As` commit footer, or create a synthetic previous tag. The top-level `bootstrap-sha` is an exclusive history cutoff, not a version selector: it omits imported history while retaining the conventional feature commits after `c3e8b53`. At least one eligible `feat:`/`fix:` is needed for a release PR. After genuine releases exist, ordinary release history determines subsequent versions; `initial-version` is not a recurring pin.

Before eventual activation, recheck both registry histories, remote tags and explicit version overrides. If any conflicting scoped release exists, stop rather than overwrite it. Review the actual first PR for **exactly 3.7.2** before merging; configuration tests are not a live release-please execution.

## External setup — only in a separately authorized phase

1. Enable GitHub Actions to create/approve PRs. Protect `main` and release tags from unreviewed changes; configure required CI checks. Dependency bots and squash titles must use Conventional Commits.
2. Create a **`publication`** environment with a required maintainer reviewer and a `main`-only branch policy. For a solo maintainer, deliberately decide whether self-review is allowed. Dispatch from main, not a tag: environment branch restrictions apply to the workflow ref, even when its checkout targets a release tag. Confirm repository plan/support for the chosen protection rules.
3. Confirm GitHub Actions may publish the repository's GitHub package (`packages: write`). Associate an existing package with this repository and grant Actions access if needed. New GitHub packages may be private; **verify/set public visibility separately**. npm's `--access public` does not configure GitHub package visibility.
4. The maintainer has confirmed ownership of npm scope `@ivannovr`; registry package creation permissions and trusted publishing still require external verification. A public 404 is not proof of permission. If npm requires an initial authenticated package creation before trusted publishing can be configured, use the separately approved bootstrap below. No npm write token is provided by these files.
5. Configure npm GitHub Actions trusted publishing for owner **`IvanNovR`**, repository **`pi-interactive-subagents`**, workflow filename **`release.yml`** (not its directory path), environment **`publication`**. Allow **direct `npm publish`**, not only staged publishing. Recheck npm's current eligibility/first-use expiry requirements immediately before setup; the reference guide's time-limit prose is not treated as a permanent guarantee.
6. OIDC requires a supported GitHub-hosted runner, `id-token: write`, and compatible Node/npm (documented minimums Node 22.14.0 / npm 11.5.1; the workflow pins newer versions). Repository metadata must match the public repository. npm publication has no npm token or `NODE_AUTH_TOKEN` and explicitly requests `--provenance`; trusted publication also supplies provenance automatically. `npm whoami` is not an OIDC trust test. An existing bootstrap artifact is skipped by matching bytes, not retroactively given provenance.
7. Enable **`RELEASE_AUTOMATION_READY=true`** only after separately approved upload/release setup. Keep **`PUBLICATION_READY` unset** until npm trust/bootstrap, GitHub package permissions and environment protection are ready. Unset or any other value disables the corresponding phase. No repository setting is changed by this checkout.

## First-release operation — future approved phase only

1. Finish local checks, review and explicitly approve the git/upload phase. Keep existing history; do not force-push or replace its root. Publication/release actions need their own approval.
2. Enable release automation only. A main push or manual **Release → operation `release`**, dispatched from **main**, opens/updates the initial release PR. Verify it proposes **3.7.2**, not a bump from 3.7.2.
3. Review and test that exact PR head. Ordinary PR workflows for `GITHUB_TOKEN`-created PRs can require approval before running; do not assume an immediate CI run. To obtain deterministic exact-head validation, a narrowly scoped `actions: write` job explicitly dispatches read-only CI from the release branch with its PR number and exact head SHA. CI verifies the current head and dispatch workflow SHA, same-repository/main targeting, PR title and every new commit. If dispatch failed, manually dispatch `ci.yml` from the release branch with both exact inputs. Never substitute CI on main for the release PR's reviewed head.
4. Squash-merge with the conventional release title. The resulting main push lets release-please create **v3.7.2** and its GitHub release. Publication, if ready, continues in that same workflow on `release_created`; it does not rely on another release event that `GITHUB_TOKEN` might not trigger. Do not race manual dispatch against the automatic run.
5. **If initial npm creation requires authenticated bootstrap:** leave `PUBLICATION_READY` disabled so the GitHub release is created without registry writes. Stop for separately approved authentication/publication. Build/test and pack the exact reviewed **v3.7.2** tag with pinned tools; preserve and publish that exact artifact through the approved bootstrap procedure. Configure trust afterward, enable publication readiness and dispatch **`retry`**, tag **`v3.7.2`**, from main. Matching npm bytes are verified/skipped and GitHub Packages is completed. A different artifact under the same immutable version is forbidden. This workflow stores no bootstrap npm credential.
6. Verify actual npm/GitHub registry versions, provenance, public package visibility and release notes. In a separately approved disposable Pi profile, verify `pi install npm:@ivannovr/pi-interactive-subagents@3.7.2` and interactive behavior. Installed-package smoke is not an interactive end-to-end test.

## Permissions, artifact identity and recovery

Release workflow permissions default to none. Only release-please receives contents/issues/PR write; release-PR dispatch receives actions write plus read access; target validation is contents-read-only. Publication receives contents read, OIDC write and packages write. Checkout does not persist credentials; actions are full-SHA pinned. All release operations share a non-cancelling concurrency group.

The protected publication job checks out an existing stable `vX.Y.Z` tag, verifies its non-draft/non-prerelease GitHub release, requires tag ancestry in main, and checks package/lock versions. It then installs/tests tagged code and packs one publication artifact for both registries. **Environment approval and reviewed main/tag history are material security boundaries:** this job has publication capabilities while running tagged install/test code. Do not approve an unreviewed tag or treat an environment declaration alone as a configured approval policy.

Dependencies install from npm before GitHub authentication is configured. npm OIDC and GitHub Packages use separate scoped npm config files; the GitHub token is exposed only in its publication step. The helper allows only the two intended registry URLs, rejects redirects, times out requests and never prints tokens.

Registry writes and GitHub release creation are **not atomic**. After a failure, fix the underlying trust/permission/network problem, then dispatch **`retry` from main** for the existing stable release tag. Recovery neither bumps versions nor creates another tag. A valid existing version is skipped only when its npm SHA-1 tarball hash matches the newly packed artifact; differing bytes fail, never overwrite. The artifact is deterministic source content, not a regenerated build/capture.

A well-formed matching **200** verifies an existing version; a valid GitHub aggregate **200** without that version, or **404**, permits a publish attempt. Malformed metadata/JSON, unexpected name/version, redirects, transport errors, 401/403, rate limits and server errors fail closed. Private registries may conceal authorization errors as 404: that permits only an attempt, never a success claim, and publish failures remain fatal. Do not replace this with `npm view ... || npm publish` or swallow errors.

## References

- Installed Mario Pi package guide: `node_modules/@mariozechner/pi-coding-agent/docs/packages.md` (the compatibility target).
- [release-please manifest bootstrap](https://github.com/googleapis/release-please/blob/main/docs/manifest-releaser.md#bootstrapping), [configuration schema](https://github.com/googleapis/release-please/blob/main/schemas/config.json), and [base strategy version selection](https://github.com/googleapis/release-please/blob/main/src/strategies/base.ts).
- [release-please Action](https://github.com/googleapis/release-please-action).
- [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) and [provenance](https://docs.npmjs.com/generating-provenance-statements).
- [GitHub Packages npm registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry).
