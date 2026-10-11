# Release notes

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
