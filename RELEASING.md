# Releases

Use SemVer: patch for compatible fixes, minor for compatible features, major for
breaking changes. While pre-1.0, breaking changes increment the minor version.
Record user-facing changes in CHANGELOG.md. Conventional Commit subjects (`fix:`,
`feat:`, `feat!:`) describe intent; version selection is explicit, not inferred
from commit messages.

After CI passes on main:

```bash
pnpm version patch --no-git-tag-version  # or minor / major / prerelease --preid rc
# Update CHANGELOG.md with the new version.
git add package.json CHANGELOG.md
git commit -m "chore: release <version>"
git tag -a v<version> -m "Release <version>"
git push origin main --follow-tags
```

A `v<package.json version>` tag starts publish.yml. The workflow rejects mismatched
tags, leading-zero numeric identifiers, and build metadata (npm does not use it
to distinguish versions). Stable releases publish to `latest`; versions such as
`0.3.0-rc.1` publish to `next`. Consumers opt in with `--version next`.

The publish workflow reruns CI, including installed-artifact smoke tests, and
publishes that exact tarball with provenance. It uses GitHub OIDC on Node 24 and
npm 11; no npm token is stored in GitHub. Manual retries must select the release
tag, never a branch. Published versions are immutable: use a new version for fixes.

## Initial npm setup

The initial package version 0.5.3 was bootstrapped from the CI-tested tarball.
The following releases use the repository-specific trusted publisher.

The npm package must exist before a trusted publisher can be configured. Publish
the first tested tarball while signed in with scope-owner access (outside CI,
use `npm publish <tarball> --access public --provenance=false`). Then configure:

```bash
npm trust github @zotoio/botz-mcp-swarm-cli --repo zotoio/botz-mcp-swarm-cli --file publish.yml --allow-publish --yes
```

The npm
account must have 2FA enabled; npm may request browser verification. Verify with
`npm trust list <package>`. The relationship explicitly permits direct publishing
and is restricted to this repository's `publish.yml`. Bootstrap releases lack
GitHub provenance; subsequent workflow releases have it.

## Diagnose publisher registration

Run `publish.yml` manually on main with **diagnose** enabled to verify the GitHub
identity and npm token exchange without publishing a package. This prints only
non-secret identity claims and npm error details, never tokens. Normal manual
releases still require an exact version tag.
