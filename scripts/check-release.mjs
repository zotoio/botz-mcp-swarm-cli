#!/usr/bin/env node
import { readFileSync, appendFileSync } from 'node:fs';
import { releasePlan } from './release-policy.mjs';
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const plan = releasePlan(pkg.version, process.env.GITHUB_REF ?? '', process.env.GITHUB_EVENT_NAME ?? '');
const out = (line) => { if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`); };
if (!plan.publish) {
  out('publish=false');
  console.log(`::warning title=Publish skipped::${plan.reason}`);
  process.exit(0);
}
const tag = plan.tag;
if (process.env.GITHUB_EVENT_NAME === 'release') {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  if (Boolean(event.release?.prerelease) !== (tag === 'next') || event.release?.draft) {
    throw new Error('Release metadata must match the package version');
  }
}
out('publish=true');
out(`tag=${tag}`);
console.log(`Validated ${pkg.version} for ${tag}`);
