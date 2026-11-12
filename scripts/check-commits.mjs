import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Last imported nonconventional commit. Enforce policy only AFTER this verified
// project-specific boundary; never rewrite history or borrow another repo's exemption.
export const legacyBoundary = 'c3e8b53c0754ae5ccc19fdab5a7481ec039bc2f7';
const conventional = /^(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\([^\r\n()]+\))?!?: \S.*$/;
const runGit = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

export function checkCommits({ git = runGit, boundary = legacyBoundary, head = 'HEAD', base, title } = {}) {
  const failures = [];
  if (title && !conventional.test(title)) failures.push('PR title must be a Conventional Commit');
  const resolveCommit = (ref) => git('rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`);
  const headSHA = resolveCommit(head);
  const boundarySHA = resolveCommit(boundary);
  // Failure is intentional for unrelated history, rather than silently skipping it.
  git('merge-base', '--is-ancestor', boundarySHA, headSHA);
  let baseSHA = boundarySHA;
  if (base && !/^0+$/.test(base)) {
    const candidate = resolveCommit(base);
    try {
      git('merge-base', '--is-ancestor', boundarySHA, candidate);
      baseSHA = candidate;
    } catch {
      // An older push/PR base is clamped to our historical policy boundary.
      git('merge-base', '--is-ancestor', candidate, boundarySHA);
    }
  }
  const commits = git('rev-list', `${baseSHA}..${headSHA}`).split('\n').filter(Boolean);
  for (const sha of commits) {
    const subject = git('show', '-s', '--format=%s', sha);
    if (!conventional.test(subject)) failures.push(`${sha}: ${subject}`);
  }
  if (failures.length) throw new Error(failures.join('\n'));
  return commits.length;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const count = checkCommits({ head: process.env.HEAD_SHA || 'HEAD', base: process.env.BASE_SHA, title: process.env.PR_TITLE });
  console.log(`Conventional Commit subjects (${count}) and PR title passed; legacy history excluded through ${legacyBoundary}.`);
}
