---
name: mcp-swarm-diagnose
description: Diagnose failed botz MCP Swarm suites, missing credentials, invalid fixtures, execution errors, and performance regressions from CLI diagnostics and run reports.
license: MIT
compatibility: Requires Node.js 22.13+ and botz-mcp-swarm or botz with the mcp-swarm extension, plus shell access. Offline validation and doctor do not require target access.
metadata:
  author: zotoio
  cli-package: "@zotoio/botz-mcp-swarm-cli"
---

# Diagnose MCP Swarm

Use `botz mcp-swarm` if installed through the botz host, or `botz-mcp-swarm` for standalone npm installs. Check the installed version and relevant command help. The plugin supplies instructions, not the CLI executable.

Begin with the existing report and offline diagnostics, using the user's suite name or directory:

```sh
botz-mcp-swarm suite list --json
botz-mcp-swarm suite validate --suite demo --json
botz-mcp-swarm doctor --suite demo --json
```

Validation checks suite structure and parameter examples. Doctor checks credential references, executables, and output permissions without contacting target or model servers. Use `doctor --inference` for model configuration issues. Report missing environment-variable names without reading or displaying their secret values.

Distinguish configuration/execution errors from failed assertions, SLO failures, and interrupted runs. Saved-suite run exit codes are 0 pass, 1 failed verdict, 2 configuration/execution error, and 130/143 interruption. Offline diagnostics use 1 for failed checks. Manifest runs have different error semantics; inspect their report rather than inferring the cause from exit 1 alone.

Inspect enabled steps and actual operation counts. A green-looking summary with no meaningful execution is not evidence of correctness. Preserve assertions while fixing malformed arguments or credential references. If target schema drift is suspected, `suite refresh --suite demo --dry-run` contacts the server without executing its tools; review the diff before applying refresh.

For two existing JSON reports:

```sh
botz-mcp-swarm compare --base base.json --head head.json
```

Compare target, workload, concurrency, duration, and enabled tool coverage before attributing latency or error changes to a regression. Separate telemetry delivery failures from test verdicts. Re-run only within the user's authorized target and load limits, and summarize the observed cause, correction, and remaining uncertainty.
