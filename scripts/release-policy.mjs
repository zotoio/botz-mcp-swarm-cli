const n = '(?:0|[1-9][0-9]*)';
const id = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
const versionPattern = new RegExp(`^${n}\\.${n}\\.${n}(?:-${id}(?:\\.${id})*)?$`);
/**
 * Decide what a publish.yml run should do. A pushed tag that is not
 * v<package version> (e.g. a pin tag such as v0.6.1-sdk1.0.40 for a consumer
 * submodule) is skipped with a warning instead of failing. Manual runs must
 * still select the exact release tag.
 */
export function releasePlan(version, ref, event) {
  if (event === 'push' && ref.startsWith('refs/tags/') && ref !== `refs/tags/v${version}`) {
    return { publish: false, reason: `${ref.slice('refs/tags/'.length)} is not v${version}; not a release tag, skipping publish` };
  }
  return { publish: true, tag: releaseTag(version, ref) };
}
export function releaseTag(version, ref) {
  if (!versionPattern.test(version)) throw new Error('Expected SemVer without leading zeroes or build metadata');
  if (ref !== `refs/tags/v${version}`) throw new Error('Publish requires a v<package-version> tag; select that tag for manual runs');
  return version.includes('-') ? 'next' : 'latest';
}
