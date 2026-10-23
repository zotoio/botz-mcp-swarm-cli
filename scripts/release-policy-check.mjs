import { test } from 'node:test';
import assert from 'node:assert/strict';
import { releasePlan, releaseTag } from './release-policy.mjs';
test('release tags must match valid SemVer exactly and prereleases use next', () => {
  assert.equal(releaseTag('1.2.3', 'refs/tags/v1.2.3'), 'latest');
  assert.equal(releaseTag('0.2.0-rc.1', 'refs/tags/v0.2.0-rc.1'), 'next');
  for (const version of ['01.2.3', '1.2.3-01', '1.2.3-', '1.2', '1.2.3+build']) {
    assert.throws(() => releaseTag(version, `refs/tags/v${version}`));
  }
  assert.throws(() => releaseTag('1.2.3', 'refs/heads/main'));
  assert.throws(() => releaseTag('1.2.3', 'refs/tags/v1.2.4'));
});
test('non-release tag pushes skip publishing; manual runs stay strict', () => {
  assert.deepEqual(releasePlan('0.7.1', 'refs/tags/v0.7.1', 'push'), { publish: true, tag: 'latest' });
  assert.equal(releasePlan('0.7.1', 'refs/tags/v0.6.1-sdk1.0.40', 'push').publish, false);
  assert.throws(() => releasePlan('0.7.1', 'refs/heads/main', 'workflow_dispatch'));
  assert.throws(() => releasePlan('0.7.1', 'refs/tags/v0.6.1', 'workflow_dispatch'));
  assert.throws(() => releasePlan('01.2.3', 'refs/tags/v01.2.3', 'push'));
});
