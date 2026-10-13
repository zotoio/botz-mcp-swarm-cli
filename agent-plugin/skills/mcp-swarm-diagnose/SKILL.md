---
name: mcp-swarm-diagnose
description: Diagnose failed botz MCP Swarm suites, missing credentials, invalid fixtures, execution errors, and performance regressions from CLI diagnostics and run reports.
license: MIT
disable-model-invocation: true
compatibility: Requires Node.js 22.13+, npm, and shell access. Installs the botz host (@zotoio/botz-cli) and its mcp-swarm extension if missing. Offline validation and doctor do not require target access.
metadata:
  author: zotoio
  cli-host: "@zotoio/botz-cli"
  cli-package: "@zotoio/botz-mcp-swarm-cli"
---

# Diagnose MCP Swarm

## Setup

Run every command through the botz host as `botz mcp-swarm`. Do not use the standalone `botz-mcp-swarm` or `swarm` executables. Before the first command in a session:

1. Run `botz --version`. If `botz` is not found, check `node --version` (22.13 or later is required), then install the host with `npm install -g @zotoio/botz-cli` and tell the user you installed it. If Node is too old or the global install fails, for example with a permissions error, stop and report it; do not use `sudo` or change npm configuration.
2. Run `botz plugins info mcp-swarm --json`. If `installedVersion` is `null`, run `botz plugins install mcp-swarm`.
3. Confirm with `botz mcp-swarm --version`, and check the relevant subcommand's `--help` before using unfamiliar options.

Begin with the existing report and offline diagnostics, using the user's suite name or directory:

```sh
botz mcp-swarm suite list --json
botz mcp-swarm suite validate --suite demo --json
botz mcp-swarm doctor --suite demo --json
```

Validation checks suite structure and parameter examples. Doctor checks credential references, executables, and output permissions without contacting target or model servers. Use `doctor --inference` for model configuration issues. Report missing environment-variable names without reading or displaying their secret values.

Distinguish configuration/execution errors from failed assertions, SLO failures, and interrupted runs. Saved-suite run exit codes are 0 pass, 1 failed verdict, 2 configuration/execution error, and 130/143 interruption. Offline diagnostics use 1 for failed checks. Manifest runs have different error semantics; inspect their report rather than inferring the cause from exit 1 alone.

Inspect enabled steps and actual operation counts. A green-looking summary with no meaningful execution is not evidence of correctness. Preserve assertions while fixing malformed arguments or credential references. If target schema drift is suspected, `suite refresh --suite demo --dry-run` contacts the server without executing its tools; review the diff before applying refresh.

For two existing JSON reports:

```sh
botz mcp-swarm compare --base base.json --head head.json
```

Compare target, workload, concurrency, duration, and enabled tool coverage before attributing latency or error changes to a regression. Separate telemetry delivery failures from test verdicts. Re-run only within the user's authorized target and load limits, and summarize the observed cause, correction, and remaining uncertainty.
