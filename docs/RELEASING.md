# Releasing

Releases of `@ivannovr/pi-interactive-subagents` are managed by [release-please](https://github.com/googleapis/release-please) and published to npm and GitHub Packages through GitHub Actions.

## Development

Use **Node.js 24.21.0** and **npm 11.19.0**, matching the CI environment.

Before submitting changes, run:

```bash
npm ci
npm test
npm run check:package
npm run check:commits
```

These checks run without model providers or live Pi/tmux sessions.

Integration tests can be run separately:

```bash
npm run test:integration
```

Integration tests launch real Pi sessions and may incur model provider costs.

## Versioning

The project follows [Semantic Versioning](https://semver.org/) and [Conventional Commits](https://www.conventionalcommits.org/).

| Commit type | Version increment |
| --- | --- |
| `fix:` | Patch |
| `feat:` | Minor |
| `BREAKING CHANGE` or `!` | Major |
| `docs:`, `chore:`, `test:`, etc. | No release by default |

Commit messages and pull request titles must follow Conventional Commits.

Release-please manages package versions, the lockfile, the release manifest, changelog entries, Git tags, and GitHub releases. Do not manually bump versions or create release tags.

## Repository setup

The following configuration is required to enable automated releases and publication.

### GitHub Actions

- Allow GitHub Actions to create pull requests.
- Configure branch protection for `main` with the required CI checks.
- Create a `publication` environment restricted to `main` with maintainer approval.
- Grant GitHub Actions write access to the repository's GitHub package.
- Ensure the GitHub package has the intended visibility.

### npm Trusted Publishing

Configure [Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) on npm using the following settings:

| Setting | Value |
| --- | --- |
| Organization or user | `IvanNovR` |
| Repository | `pi-interactive-subagents` |
| Workflow | `release.yml` |
| Environment | `publication` |

Enable direct package publishing.

The release workflow uses OIDC authentication and publishes npm packages with provenance. No long-lived npm access token is required.

If npm requires initial package creation before Trusted Publishing can be configured, publish the exact artifact from the reviewed release tag, configure Trusted Publishing, and retry the release workflow.

### Repository variables

Configure the following variables under **Settings → Secrets and variables → Actions**:

| Variable | Value | Purpose |
| --- | --- | --- |
| `RELEASE_AUTOMATION_READY` | `true` | Enables release automation |
| `PUBLICATION_READY` | `true` | Enables package publication |

Both variables are disabled unless explicitly set to `true`.

Enable publication only after npm Trusted Publishing and GitHub Packages permissions are configured.

## Release workflow

1. Merge changes into `main` using Conventional Commits.
2. Release-please opens or updates a release pull request containing the next version and generated changelog.
3. Review the release pull request, remove any duplicate manual Unreleased notes, and ensure all required CI checks pass for the current PR head.
4. Squash-merge the release pull request.
5. Release-please creates the Git tag and GitHub release.
6. Approve the `publication` environment deployment.
7. GitHub Actions validates the release and publishes the same package tarball to npm and GitHub Packages.

If required CI checks are missing from the release pull request, review and approve the pending PR workflow. Do not bypass branch protection.

The release workflow can also be triggered manually from **Actions → Release**, using the `release` operation on `main`.

After publication, verify the package version, npm provenance, GitHub package visibility, and release notes.

To verify installation:

```bash
pi install npm:@ivannovr/pi-interactive-subagents@<version>
```

## Recovery

If publication fails, resolve the underlying authentication, permission, or registry issue and retry the existing release:

1. Open **Actions → Release → Run workflow**.
2. Select the `main` branch.
3. Set the operation to `retry`.
4. Specify the existing release tag (`vX.Y.Z`).
5. Approve the publication deployment.

Recovery does not create a new release or increment the package version.

If a package version already exists in a registry, the workflow verifies its artifact hash and skips publication when the contents match. Conflicting artifacts cause the workflow to fail.

Never overwrite an existing package version or create a replacement tag to recover from a publication failure.

## References

- [Semantic Versioning](https://semver.org/)
- [Conventional Commits](https://www.conventionalcommits.org/)
- [Release Please Action](https://github.com/googleapis/release-please-action)
- [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/)
- [npm provenance](https://docs.npmjs.com/generating-provenance-statements)
- [GitHub Packages npm registry](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry)