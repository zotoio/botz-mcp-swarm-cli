# Release notes

## 0.6.0

- Move CLI files under `.botz/mcp-swarm/`: suites in `suites/`, run reports in `runs/` (previously the cwd or `.runs/`), credentials in `config.json`, and skill records in `skill-installations.json`. Suites and credentials in the earlier `.botz/` locations are still read.
- Add `.botz/mcp-swarm/settings.json` with `suitesDir` and `runsDir`. Inside a repository, the repository settings, suites, and credentials take precedence over `~/.botz/mcp-swarm`, which is a read-only fallback.
- Use conservative load defaults and a 60-second drain allowance for new captured suites; preserve explicit stored values and overrides.
- Add portable Agent Skills and explicit install/update/status/uninstall commands for Cursor, Claude Code, and Codex.
- Bundle marketplace plugin manifests and preserve locally edited skill files.

## 0.5.4

- Release through the GitHub npm trusted-publishing workflow after the initial registry bootstrap.
- Bound CI and publishing jobs so stalled installations cannot run indefinitely.

## 0.5.3

- Move the MCP Swarm extension to public `zotoio/botz-mcp-swarm-cli`, with an independent engine, build, tests, and release workflow.
- Document `botz mcp-swarm [args]` as the primary invocation; `botz-mcp-swarm` remains the host-discovered executable. The TypeScript `botz` host is published separately as `@zotoio/botz-cli`.

- Add strict SemVer tag validation and npm trusted publishing of the tested artifact.

- Behavior change: capture and standalone saved-suite runs now default to MCP-only testing. Add `--inference` to preserve previous model-generation/evaluation behavior; `--no-inference` still works.
- Added unified `suite capture|show|list|validate|refresh|run` commands, retaining existing top-level aliases.
- Added invocation-only `--url` and `--target-file` overrides without inherited endpoint credentials.
- Added suite duration, ramp, dwell, jitter, and soak controls. Iteration-only suites now honor concurrency through the load engine.
- Added `suite refresh --dry-run`, preserving edited arguments/assertions, parameter files, and disabled retired steps.
- Added `--format json|junit` for suite and manifest runs, actionable offline diagnostics, and shared execution configuration. Run configuration failures exit 2; failed verdicts exit 1.

- Standalone manifest and soak runs no longer read service policy, write service run history, or enable a local OTLP collector automatically. Explicit OTEL configuration remains supported; export failures do not discard reports.
- Saved stdio suites retain their capture working directory. Bare script arguments work when invoking the suite from a different repository directory.
- HTTP credential overrides replace fields case-insensitively.
- Discovery rejects incomplete pagination and failed advertised primitive lists. Servers without tools can be captured without tool inference.
- Capture protects existing suites; use `--force` to replace them. New suites use version 1 files and independent credential IDs; legacy unversioned suites still load.
- Query credentials are refused by default. `--url-key-as-bearer` explicitly opts into conversion for servers that accept bearer authentication.
- Added offline `suite list`, `suite validate`, and `doctor`, with `--json` output.
- Releases require matching version tags and the full CI/consumer matrix. Prereleases use `next`. The tested tarball is published without rebuilding.
