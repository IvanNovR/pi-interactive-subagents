import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkCommits } from '../scripts/check-commits.mjs';

function fixture({ base = 'new-base', subjects = ['feat: add feature', 'chore(main): release 1.0.0'], related = true } = {}) {
  const calls = [];
  const git = (...args) => {
    calls.push(args);
    if (args[0] === 'rev-parse') return args.at(-1).replace(/\^\{commit\}$/, '');
    if (args[0] === 'merge-base') {
      const [, , ancestor, descendant] = args;
      const valid = ancestor === 'boundary' && ['head', 'new-base', 'boundary'].includes(descendant) ||
        ancestor === 'old-base' && descendant === 'boundary';
      if (!valid || !related) throw new Error('Not an ancestor');
      return '';
    }
    if (args[0] === 'rev-list') return subjects.map((_, i) => `commit-${i}`).join('\n');
    if (args[0] === 'show') return subjects[Number(args.at(-1).split('-')[1])];
    throw new Error(`Unexpected git call: ${args}`);
  };
  const check = (options = {}) => checkCommits({ git, boundary: 'boundary', head: 'head', base, ...options });
  return { calls, check };
}

test('commit policy checks the supplied new range and conventional bot title', () => {
  const { check, calls } = fixture();
  assert.equal(check({ title: 'chore(main): release 1.0.0' }), 2);
  assert.ok(calls.some(([cmd, range]) => cmd === 'rev-list' && range === 'new-base..head'));
});
for (const base of [undefined, '', '0000000000000000000000000000000000000000', 'old-base']) {
  test(`legacy history is bounded for base ${JSON.stringify(base)}`, () => {
    const { check, calls } = fixture({ base: base ?? '' });
    assert.equal(check(), 2);
    assert.ok(calls.some(([cmd, range]) => cmd === 'rev-list' && range === 'boundary..head'));
  });
}
test('unrelated history fails instead of bypassing policy', () => {
  assert.throws(() => fixture({ related: false }).check(), /Not an ancestor/);
});
test('all new nonconventional commits and PR titles are rejected', () => {
  assert.throws(() => fixture({ subjects: ['feat: valid', 'updated things'] }).check({ title: 'Bad title' }), /PR title.*\ncommit-1: updated things/);
});
test('an empty new range is valid', () => {
  assert.equal(fixture({ subjects: [] }).check(), 0);
});
