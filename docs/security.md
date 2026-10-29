# Security: CI supply chain

Approved 2026-10-29 (security decision D5). This package has no HTTP server, so the D1 OAuth grant and D2 body-cap decisions apply to botz-mcp-swarm, not here.

## CI supply chain: action pinning and Dependabot (D5)

- Every third-party `uses:` is pinned to a full 40-character commit SHA followed by a `# vX.Y.Z` comment. Tags and branches (`@v4`, `@release/v1`) are not allowed.
- Every workflow sets top-level `permissions: contents: read`. Jobs widen only what they need (for example `pages: write` + `id-token: write` for GitHub Pages, `id-token: write` for PyPI/npm trusted publishing).
- `.github/dependabot.yml` runs weekly (Monday 09:00 Australia/Sydney), one grouped PR per ecosystem: `github-actions` plus each package ecosystem the repo uses. Dependabot updates the SHA and the version comment together.
- An `actionlint` CI job (actionlint v1.7.12, download script pinned by commit) lints all workflows, including shellcheck on `run:` blocks.
- To pin a new action: resolve the tag to its commit (`git ls-remote https://github.com/OWNER/REPO refs/tags/vX.Y.Z`) and write `uses: OWNER/REPO@<sha> # vX.Y.Z`.
