const n = '(?:0|[1-9][0-9]*)';
const id = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
const versionPattern = new RegExp(`^${n}\\.${n}\\.${n}(?:-${id}(?:\\.${id})*)?$`);
export function releaseTag(version, ref) {
  if (!versionPattern.test(version)) throw new Error('Expected SemVer without leading zeroes or build metadata');
  if (ref !== `refs/tags/v${version}`) throw new Error('Publish requires a v<package-version> tag; select that tag for manual runs');
  return version.includes('-') ? 'next' : 'latest';
}
