// Called only by the protected publication workflow; never an npm lifecycle hook.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const [registry, tarball] = process.argv.slice(2);
if (!['https://registry.npmjs.org', 'https://npm.pkg.github.com'].includes(registry) || !tarball) {
  throw new Error('Expected an allowed registry URL and a tarball path');
}
const pkg = JSON.parse(readFileSync('package.json'));
const headers = { Accept: 'application/json' };
const isGitHub = registry === 'https://npm.pkg.github.com';
if (isGitHub) {
  if (!process.env.NODE_AUTH_TOKEN) throw new Error('GitHub Packages token is required');
  headers.Authorization = `Bearer ${process.env.NODE_AUTH_TOKEN}`;
}
const url = isGitHub
  ? `${registry}/${encodeURIComponent(pkg.name)}`
  : `${registry}/${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}`;
const response = await fetch(url, {
  headers, redirect: 'error', signal: AbortSignal.timeout(60_000),
});
const publish = () => execFileSync('npm', ['publish', tarball, ...(!isGitHub ? ['--provenance'] : []), '--registry', registry, '--access', 'public'], { stdio: 'inherit' });
if (response.status === 200) {
  const body = await response.json();
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.name !== pkg.name) {
    throw new Error('Unexpected registry metadata');
  }
  if (isGitHub && (!body.versions || typeof body.versions !== 'object' || Array.isArray(body.versions))) {
    throw new Error('Unexpected registry versions metadata');
  }
  const present = !isGitHub || Object.hasOwn(body.versions, pkg.version);
  if (!present) {
    // A valid GitHub aggregate may omit this version. Publication must still succeed.
    publish();
  } else {
    const existing = isGitHub ? body.versions[pkg.version] : body;
    if (!existing || typeof existing !== 'object' || Array.isArray(existing) || existing.version !== pkg.version ||
        (existing.name !== undefined && existing.name !== pkg.name)) {
      throw new Error('Unexpected registry version metadata');
    }
    const shasum = createHash('sha1').update(readFileSync(tarball)).digest('hex');
    if (existing.dist?.shasum !== shasum) throw new Error('Published version has different bytes; refusing to skip or overwrite it');
    console.log(`${pkg.name}@${pkg.version} already exists with identical tarball bytes on ${registry}; skipping.`);
  }
} else if (response.status === 404) {
  // A private registry may conceal authorization failures as 404. This permits
  // only an attempt, never a success claim; all npm errors remain fatal.
  publish();
} else {
  throw new Error(`Registry lookup failed (HTTP ${response.status}); not treating this as a missing version`);
}
