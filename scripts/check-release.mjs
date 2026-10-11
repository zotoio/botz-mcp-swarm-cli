#!/usr/bin/env node
import { readFileSync, appendFileSync } from 'node:fs';
import { releaseTag } from './release-policy.mjs';
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const tag = releaseTag(pkg.version, process.env.GITHUB_REF ?? '');
if (process.env.GITHUB_EVENT_NAME === 'release') {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  if (Boolean(event.release?.prerelease) !== (tag === 'next') || event.release?.draft) {
    throw new Error('Release metadata must match the package version');
  }
}
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tag=${tag}\n`);
console.log(`Validated ${pkg.version} for ${tag}`);
