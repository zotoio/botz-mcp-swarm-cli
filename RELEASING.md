# Releases

Releases are automated with [semantic-release](https://semantic-release.gitbook.io/).
Every push to `main` runs `publish.yml`: it reruns CI (including installed-artifact
smoke tests), then semantic-release reads the Conventional Commit messages since the
last `v*` tag and picks the version:

- `fix:` (and `perf:`) gives a patch release.
- `feat:` gives a minor release.
- `feat!:` or a `BREAKING CHANGE:` footer gives a major release.
- `chore:`, `docs:`, `ci:`, `test:`, `refactor:` and `build:` give no release.

PRs are squash-merged, so the PR title is the release commit and must be a
Conventional Commit. semantic-release then publishes to npm (`latest`) with
provenance, pushes the `v<version>` tag and creates the GitHub release with
generated notes. Nothing is committed back to `main`: the version in `package.json`
on `main` is the last manual bump, and the published package carries the released
version. GitHub releases hold the notes from now on; CHANGELOG.md covers earlier versions.

The release job runs in the protected GitHub environment `release` (main only) and
uses GitHub OIDC on Node 24 with npm 11.21.1; no npm token is stored in GitHub.
Published versions are immutable: use a new commit for fixes.

## Initial npm setup

The initial package version 0.5.3 was bootstrapped from the CI-tested tarball.
The following releases use the repository-specific trusted publisher.

The npm package must exist before a trusted publisher can be configured. Publish
the first tested tarball while signed in with scope-owner access (outside CI,
use `npm publish <tarball> --access public --provenance=false`). Then configure:

```bash
npm trust github @zotoio/botz-mcp-swarm-cli --repo zotoio/botz-mcp-swarm-cli --file publish.yml --env release --allow-publish --yes
```

The npm
account must have 2FA enabled; npm may request browser verification. Verify with
`npm trust list <package>`. The relationship explicitly permits direct publishing
and is restricted to this repository's `publish.yml` in the `release` environment. Bootstrap releases lack
GitHub provenance; subsequent workflow releases have it.

## Diagnose publisher registration

Run `publish.yml` manually on main with **diagnose** enabled to verify the GitHub
identity and npm token exchange without publishing a package. This prints only
non-secret identity claims and npm error details, never tokens. Releases only run from pushes to `main`.
