---
name: mcp-swarm
description: Capture, validate, refresh, and run MCP test suites with the botz MCP Swarm CLI. Use for testing MCP servers, repeatable tool assertions, load tests, and CI reports.
license: MIT
disable-model-invocation: true
compatibility: Requires Node.js 22.13+, npm, and shell access. Installs the botz host (@zotoio/botz-cli) and its mcp-swarm extension if missing. Live capture and runs require access to the target MCP server.
metadata:
  author: zotoio
  cli-host: "@zotoio/botz-cli"
  cli-package: "@zotoio/botz-mcp-swarm-cli"
---

# MCP Swarm suites

## Setup

Run every command through the botz host as `botz mcp-swarm`. Do not use the standalone `botz-mcp-swarm` or `swarm` executables. Before the first command in a session:

1. Run `botz --version`. If `botz` is not found, check `node --version` (22.13 or later is required), then install the host with `npm install -g @zotoio/botz-cli` and tell the user you installed it. If Node is too old or the global install fails, for example with a permissions error, stop and report it; do not use `sudo` or change npm configuration.
2. Run `botz plugins info mcp-swarm --json`. If `installedVersion` is `null`, run `botz plugins install mcp-swarm`.
3. Confirm with `botz mcp-swarm --version`, and check the relevant subcommand's `--help` before using unfamiliar options.

For a new target, capture a suite:

```sh
botz mcp-swarm suite capture --url http://127.0.0.1:3000/mcp --name demo
botz mcp-swarm suite show --suite demo
botz mcp-swarm suite validate --suite demo --json
botz mcp-swarm doctor --suite demo --json
botz mcp-swarm suite run --suite demo --format json
```

Use the user's actual target. For stdio, substitute `--command <bin>` and repeated `--arg <value>` for `--url`. Capture contacts the live server. Inspect captured arguments and enabled steps before running; tool calls can change target data. Choose concurrency and duration within the requested test scope. Inference is opt-in with `--inference` and needs model configuration; ordinary capture and runs do not need model credentials.

Suites live under `.botz/suites/<name>` at the Git root, or under the user's `.botz/suites` outside a repository. Reuse an existing suite instead of overwriting it. Capture refuses an existing suite unless `--force` is supplied. To inspect server changes while preserving assertions and custom arguments:

```sh
botz mcp-swarm suite refresh --suite demo --dry-run
botz mcp-swarm suite refresh --suite demo
```

Refresh discovers the live surface without executing target tools. Review schema changes and disabled/removed steps before a subsequent run. Do not silently enable write-like tools.

Use environment references for credentials, such as `--bearer-env MCP_TOKEN` or `--header-env X-Api-Key=MCP_KEY`. Do not print secret values or put credentials in suite files. A target override (`--url` or `--target-file`) replaces saved credentials; supply the override's credentials explicitly.

For sustained load, set explicit `--duration-ms`, `--concurrency`, and optionally `--ramp-up-ms`/`--ramp-down-ms`. For CI, use `--format json` or `--format junit`, and preserve the process exit status. Saved-suite runs exit 0 for pass, 1 for failed verdict, 2 for configuration/execution errors, 130/143 for interruption. Report verdict, executed coverage, failures, and report locations; never call a run successful just because a report exists or no enabled tools executed.
