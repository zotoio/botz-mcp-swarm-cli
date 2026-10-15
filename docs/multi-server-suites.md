# Multi-server suites

A suite can call tools on up to 8 MCP servers in one ordered flow, passing values from one server's result into another server's call, as an agent does when it completes a task. Single-server suites, manifests, and reports work exactly as before.

## Concepts

- **Server alias.** A short name for one server in a suite, such as `github`: 1 to 32 characters of `a-z`, `0-9`, and `-`. Steps, reports, credentials, and CLI flags refer to servers by alias.
- **Default server.** The alias that steps without a `server` field call. A single-server suite has one server, called `default`.
- **Flow.** One full pass through the suite by one virtual user. Its sessions and variables belong to that pass.

## Building a suite

```bash
# Capture the first server. --alias names it; without it the alias is "default".
botz mcp-swarm suite capture --url https://gh-mcp.example/mcp --name triage-flow --alias github --bearer-env GH_TOKEN

# Add more servers. Each is introspected and its surface saved under its alias.
botz mcp-swarm suite server add --suite triage-flow --alias jira --url https://jira-mcp.example/mcp --bearer-env JIRA_TOKEN
botz mcp-swarm suite server add --suite triage-flow --alias slack --command slack-mcp --env-from SLACK_TOKEN=SLACK_TOKEN

botz mcp-swarm suite server list --suite triage-flow
botz mcp-swarm suite show --suite triage-flow
```

| Command | What it does |
| --- | --- |
| `suite server add --alias <a> (--url \| --command [--arg]) [credential flags] [--steps] [--inference]` | Introspects the server and adds it. `--steps` also adds its default contract steps in a disabled frame called `<alias> contract`, with write-like tools disabled. |
| `suite server list [--json]` | Alias, transport, endpoint, tool count, enabled steps, objectives, and which server is the default. |
| `suite server remove --alias <a> [--force]` | Refused while an enabled step calls the server, naming those steps. `--force` disables them. The default server cannot be removed. |
| `suite server rename --alias <a> --to <b>` | Renames the alias in the suite, its steps, its credential references, and saved credentials. |
| `suite server default --alias <a>` | Makes another server the default. Steps keep calling the server they called. |
| `suite server slo --alias <a> [--max-p95-ms] [--max-p99-ms] [--max-error-rate]` | Sets objectives judged over every tool call on that server. No limits clears them. |

Steps are wired in `suite.json` (or the admin UI). A suite with more than one server, a non-default alias, or a server objective is written as `schemaVersion: 2`; otherwise it stays version 1, so older CLIs can read it. An older CLI refuses a version 2 file with an upgrade message.

## The suite file

```json
{
  "kind": "botz-suite",
  "schemaVersion": 2,
  "name": "triage-flow",
  "defaultServer": "github",
  "servers": {
    "github": { "target": { "transport": "streamable-http", "url": "https://gh-mcp.example/mcp" }, "surface": {} },
    "jira": { "target": { "transport": "streamable-http", "url": "https://jira-mcp.example/mcp" }, "surface": {}, "slo": { "maxP95Ms": 800 } },
    "slack": { "target": { "transport": "stdio", "command": "slack-mcp" }, "surface": {} }
  },
  "nodes": [
    { "id": "find", "type": "sampler", "enabled": true, "method": "tools/call", "tool": "search_issues", "args": { "query": "is:open label:${label}" } },
    { "id": "title", "type": "extractor", "enabled": true, "path": "structuredContent.items[0].title", "variable": "issueTitle", "required": true },
    { "id": "ticket", "type": "sampler", "enabled": true, "server": "jira", "method": "tools/call", "tool": "create_issue", "args": { "summary": "${issueTitle}" } },
    { "id": "key", "type": "extractor", "enabled": true, "path": "structuredContent.key", "variable": "ticketKey" },
    { "id": "notify", "type": "sampler", "enabled": true, "server": "slack", "method": "tools/call", "tool": "post_message", "args": { "text": "Opened ${ticketKey}" } }
  ],
  "params": { "label": { "example": "bug", "usedBy": ["find"] } },
  "load": { "durationMs": 0, "maxConcurrency": 1, "iterations": 1 }
}
```

- `nodes[].server` is allowed on samplers, groups, and loops. A frame's children inherit it unless they set their own. Extractors and think steps call no server, so they never carry one.
- `nodes[].required` (extractors only): a missing or empty value fails the extractor with `extract_missing: <name> (<path>)`. Steps that depend on it are skipped for that pass and counted as skipped, not as errors against their server.
- A step that uses `${name}` waits for the extractor that sets `name`, on any server.

## Validation

`suite validate` checks, without contacting any server:

| Rule | Example error |
| --- | --- |
| `defaultServer` is a server | `defaultServer: "gh" is not a server` |
| Every step's `server` is a server | `nodes[2].server: "jira2" is not a server` |
| A tool step's tool is on its server (an error on multi-server suites, a warning otherwise) | `nodes[2].tool: create_issue is not on server jira` |
| `server` is not set on extractors or think steps | `nodes[1].server: extractors do not call a server` |
| A variable is set before a step uses it | `nodes[4]: ${issueTitle} is not set before this step` |
| Two extractors do not set the same variable | `nodes[3].variable: ticketKey is already set by key` |
| A server no enabled step uses | Warning only |

`suite validate` and `suite show` list every value that moves between servers, so a reviewer sees the data flow:

```text
Cross-server data flows
  github  find   -> issueTitle -> jira   ticket
  jira    ticket -> ticketKey  -> slack  notify
```

## Credentials

- Literal values are saved to `.botz/mcp-swarm/config.json` under the suite; `suite.json` keeps references.
- Another server's variables carry its alias: `SWARM_TARGET_JIRA_HEADER_AUTHORIZATION`, `SWARM_TARGET_SLACK_ENV_SLACK_TOKEN`. The default server keeps the single-server names, so existing CI secrets keep working.
- Credential flags take an optional alias prefix on `run`, `doctor`, and `refresh`: `--bearer-env jira=JIRA_TOKEN`, `--header jira:X-Api-Key: value`, `--header-env jira:X-Api-Key=JIRA_KEY`, `--env slack:KEY=value`, `--env-from slack:SLACK_TOKEN=SLACK_TOKEN`. Unprefixed values apply to the default server. A header for one server is never sent to another.

## Running and overriding targets

```bash
botz mcp-swarm suite run --suite triage-flow --concurrency 4 --duration-ms 30000
botz mcp-swarm suite run --suite triage-flow --target jira=https://jira-staging.example/mcp --bearer-env jira=JIRA_STAGING_TOKEN
botz mcp-swarm suite run --suite triage-flow --target-file targets/staging.json   # { "servers": { "jira": {...}, "slack": {...} } }
```

- `--target <alias>=<url>` replaces one HTTP server's URL. Like `--url`, it replaces all headers and inherits no saved credentials.
- `--url` on a suite with more than one server exits 2 with `suite <name> has <n> servers; use --target <alias>=<url>`.
- `--target-file` takes a single target (the default server) or a `{ "servers": { ... } }` map.
- `doctor` checks each stdio server's executable; `suite refresh` refreshes every server, or one with `--server <alias>`. A tool removed from one server disables only the steps on that server.

## The load engine

Each server has its own session pool. A virtual user checks out a session for a server when its first step on that server runs, holds it for the pass, and releases every session when the pass ends. A pass that never reaches a server never opens a session to it. Ten virtual users open up to ten sessions on each server.

- Warm-up opens sessions on every server a step calls. A failure names the server: `Session warm-up failed on jira: ...`.
- `maxConcurrency` still counts virtual users, `maxCallCount` counts calls across all servers, and the other load settings mean what they did.
- A server that cannot be reached mid-run fails the step with error class `transport`, counted against that server; steps before it keep their real numbers.
- Telemetry spans and metrics carry `mcp.server.alias`; run events carry `server`.

## Reports

A multi-server report keeps every single-server field, filled from the default server, and adds:

| Field | Contents |
| --- | --- |
| `servers` | Per alias: name, version, transport, scrubbed endpoint, calls, error rate, latency, and session counts. Single-server reports have one entry. |
| `toolSeries[].server`, `rpcSeries[].server`, `nodeOutcomes[].server` | The alias. Two servers may each have a `search` tool; each gets its own row. |
| `nodeOutcomes[].skipped` | Passes where a step did not run because a required variable upstream was missing. |
| `flow` | Passes, failed passes, skipped passes, and whole-pass latency. |
| `variables` | Per extractor: name, step, source server, and how often it found a value. Never the value. |
| `catalog[].server` | The server of each tool, so `compare` decides `schema-changed` per server. |
| `processSummary.suts` | Stdio server processes by alias. |

Extracted values are never written to reports, events, or logs; `redactedArgs` shows them as `${name}`. The Markdown report adds Flow, Servers, Steps, and Variables sections, and `--format junit` uses each step's alias as its test case `classname`.

`compare` matches rows by server and tool, warns when a server is added, removed, or points elsewhere, and reports a flow p95 regression above 20% for multi-server runs. Reports without server fields compare against the other report's default server.

## Manifests

A manifest can list more servers in `targets` and name the server a step calls:

```json
{
  "target": { "transport": "stdio", "command": "node", "args": ["github.mjs"] },
  "defaultTarget": "github",
  "targets": { "jira": { "transport": "streamable-http", "url": "https://jira-mcp.example/mcp" } },
  "assertions": { "servers": { "jira": { "maxP95Ms": 800, "maxErrorRate": 0.01 } } },
  "scenarios": [{ "name": "triage", "steps": [
    { "method": "tools/call", "tool": "search_issues" },
    { "method": "extract", "extract": { "variable": "issueTitle", "path": "structuredContent.items[0].title", "required": true } },
    { "method": "tools/call", "tool": "create_issue", "server": "jira", "args": { "summary": "${issueTitle}" } }
  ] }]
}
```

Every target must pass the allowlist. `assertions.servers` sets per-server objectives.

## Project suites

Project suite steps store a project server id in `server`. `project suite add-node` and `set-node` take `--server <id|name>` (an empty value clears it) and `--required` / `--optional` for extractors; `project suite server-slo` sets a server's objectives. A run names servers by aliases made from their names (`GitHub Prod` becomes `github-prod`). A suite whose steps call only its own server runs exactly as before. Worker assignments carry `targets` and `defaultServer`; `--allow-stdio` is needed if any target is stdio, and a refusal names the server.

## Not in this version

Sharing values between virtual users, model-driven tool choice across servers, per-server call caps, and record/replay across servers.
