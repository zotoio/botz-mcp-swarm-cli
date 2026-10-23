# Release notes

## 0.9.0

- New `suite analyse <suite>`: the configured model reads a failed run's errors, the suite steps and the server's tool schemas (secrets and headers redacted) and proposes fixes. Each proposal has an id, category (`suite_bug`, `server_bug`, `environment`), confidence, rationale and evidence; only suite bugs carry a JSON patch, validated against the suite before it is offered. Nothing changes unless you name ids: `--from <analysis.json> --apply <ids>` writes `suite.proposed.json` (or `suite.json` with `--in-place`, keeping a `.bak`), and `--reject <ids>` records a rejection. Enabling write-like tools needs `--allow-destructive`. `SWARM_ANALYSE=off` disables it.
- Run reports record `loadTimeline`: active VUs and TPS over time, overall and per tool (1s buckets, widened for long runs to at most 600 points), with peak/avg VUs and TPS. Run output and the Markdown report show a peak/avg table with sparklines. Manifest runs without VU events use calls in flight for overall VUs.
- `@modelcontextprotocol/sdk` ^1.32.1, matching botz-mcp-swarm.
- Run reports record `sampleResults`: per tool, the first successful response and the first error, with redacted args and payloads truncated to 4KB (`truncated: true` when cut).
- Run reports record `timeSeries`: per-second buckets for the whole run with `calls`, `errors`, `byTool`, `vus`, `latency` (p50/p95), and `byToolLatency`. Not limited by the run log's line cap, so report tooling can use it instead of parsing logs.
- Both fields are optional; older reports still load.

## 0.8.0

- Retry MCP calls that fail because of rate limiting, on by default. Rate limiting is detected from HTTP 429, a `Retry-After` header, or rate limit / too many requests / quota text in JSON-RPC errors, error data, or tool error text. Such errors now use the new `rate_limit` error class; previously messages that mentioned API keys could be counted as `auth`.
- Exponential backoff with full jitter (defaults: base 500ms, factor 2, max delay 30s, max 5 retries). `Retry-After` is honoured, and a `Retry-After` longer than the max delay stops retrying. Covers session setup (connect and initialize) and every step; other error classes are never retried.
- Configure with `load.retry` (suite) or top-level `retry` (manifest/server); `{ "enabled": false }` turns it off. Retries never wait past ramp-down or the run's max duration.
- Only final outcomes count toward error rates. Each retry emits an `mcp.retry` event (reason `rate_limit`), and reports include `retries` totals and per-node `retries` counts.
- Release workflow: pushing a tag that is not `v<package version>` (for example a submodule pin tag) now skips publishing with a warning instead of failing.

## 0.7.0

- Move the Agent Skills to the `botz-mcp-swarm` plugin in [zotoio/zoto-agents](https://github.com/zotoio/zoto-agents), which publishes it for Cursor, Claude Code, and Codex. The package no longer bundles `agent-plugin/`.
- `skills status` and `skills uninstall` now report and remove copies installed by 0.6.x; `skills install` and `skills update` print the marketplace instructions and exit 1.
- Run reports record `server`: the server name and version from the run's `initialize` result (saved-suite runs fall back to the suite's surface), the transport, and the endpoint actually used. HTTP endpoints drop userinfo, query, and fragment; stdio endpoints reduce the command and absolute path arguments to their basename. The Markdown report header shows the server and endpoint.
- Saved-suite run reports include the suite's tool `catalog`, so `compare` marks tools whose schema changed as `schema-changed` and leaves them unscored, as it already did for project runs.
- `compare` shows each side's server and warns (in Markdown and in the JSON `warnings` array) when base and head ran against a different server name, transport, or endpoint.
- `optimize` now reads the tool's actual description and parameter descriptions; previously it treated the tool name as the current description.
- Behavior change: `optimize` no longer calls the tool. It used to call the tool twice with hard-coded `{ "message": ... }` arguments, whatever its schema and even when the tool was write-like.
- Remove the latency "A/B bench" and `benchDelta` from new optimize drafts and history, because a description change cannot affect server latency. To compare before and after, run `suite run --inference` tool evals.
- `optimize --tool` is required (it previously defaulted to `echo`). An unknown tool exits 1 and lists the available tools.
- The offline heuristic now reports concrete description gaps instead of appending the names of required arguments.
- Standalone `project run` works: the servers added to the project are the run's target consent, instead of the swarm service's org allowlist, which rejected them. Previously every standalone project run failed, stored nothing, and printed `report_missing`.
- A project run that fails before the runner produces a report now stores a failed report with the reason, so it appears in `project runs` and `project report`, and the reason is printed.
- `project` commands exit non-zero on failure, including an unreachable server on `add`, `introspect`, or `show`, and an invalid `run --version`.
- `project run` runs model evals only with `--inference`, matching `suite run`. `--version <n>` now selects the suite version instead of printing the CLI version.
- Generated suites size their ramp-down from the latency measured while introspecting, so a slow server is not cut off mid-pass with `ramp-down deadline`. It is never below the 60-second default and at most 30 minutes. The measured latency is not stored in `suite.json`.

## 0.6.1

- Add `upgrade`, which previews and, with `--apply`, moves files from earlier layouts into `.botz/mcp-swarm/` through ordered, versioned migration steps. Credentials are merged without overwriting newer values; existing targets are reported as conflicts.
- Add the `mcp-swarm-upgrade` Agent Skill to guide agents through upgrading the CLI, migrating files, fixing git tracking, refreshing skills, and verifying suites.
- Keep studio and service state under `.botz/mcp-swarm/data/` (formerly `.swarm-data/`) and local OTLP data under `.botz/mcp-swarm/otel/` (formerly `.otel/`). Run `upgrade --apply` to move an existing `.swarm-data/` and `.otel/` there. Repository `.gitignore` files written by the CLI now also ignore `data/` and `otel/`.

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
