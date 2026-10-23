# Standalone suite CLI

Point the CLI at an MCP server, introspect it, save a suite as files, and run that suite again with a different parameter set. No admin process, no login, no org policy, no allowlist.

## Goal

```bash
botz mcp-swarm capture --url http://127.0.0.1:3000/mcp --name demo
botz mcp-swarm run --suite demo --params ./cases/small.json
botz mcp-swarm run --suite demo --params ./cases/large.json
```

`stdio` is the same shape: `--command <bin> --arg <a>` instead of `--url`.

Each command is one process. It connects, writes files or a report, and exits. It does not start the admin server, read `.botz/mcp-swarm/data/policy.json`, read role grants or `SWARM_PRINCIPAL`, or require a principal.

This is one of the CLI's two modes. The other, `worker`, is opt-in and authenticates to a service with `SWARM_WORKER_TOKEN`; see the README. Nothing on this page uses the worker token.

## Where files go

| What | Inside a git repository | Outside a git repository |
| --- | --- | --- |
| Suites | `<repo>/.botz/mcp-swarm/suites/<name>/` | `~/.botz/mcp-swarm/suites/<name>/` |
| Run reports (`run --suite`, `run --manifest`, `soak`) | `<repo>/.botz/mcp-swarm/runs/` | `~/.botz/mcp-swarm/runs/` |
| Literal credentials | `<repo>/.botz/mcp-swarm/config.json` | `~/.botz/mcp-swarm/config.json` |
| Directory settings | `<repo>/.botz/mcp-swarm/settings.json` | `~/.botz/mcp-swarm/settings.json` |

- `<repo>` is the nearest ancestor of the current directory that has a `.git` entry, so a subdirectory uses the repository's `.botz/mcp-swarm/`.
- `settings.json` may set `suitesDir` and `runsDir`. Relative paths resolve from the git root for the repository file and from home for `~/.botz/mcp-swarm/settings.json`; `~/` and absolute paths also work. `capture --out <dir>` and `run --output <dir>` override both for one command.
- Inside a repository, the repository's `.botz/mcp-swarm` takes precedence and `~/.botz/mcp-swarm` is a read-only fallback: a repository setting wins over the home one, a bare suite name is looked up in the repository suites before the home suites, and repository credentials override home credentials key by key. Writes go to the repository only, so home credentials are never copied into it.
- Suites and credentials in the earlier `.botz/suites/` and `.botz/config.json` locations are still read; the next credential save writes `.botz/mcp-swarm/config.json`.
- `capture` turns the suite name (`--name`, else the host or command) into one path segment under the suites directory.
- `run --suite` and `show --suite` take a directory that holds `suite.json`, or a bare suite name.
- Inside a repository the CLI writes `.botz/mcp-swarm/.gitignore` with `config.json` and `runs/` lines (appended if the file exists). `suites/` and `settings.json` are not ignored, so they can be committed. No `.gitignore` is written under `~/.botz/`.
- `run --suite` names reports `botz-run-<timestamp>.json` and `.md`; `run --manifest` and `--output` runs name them `<runId>.json` and `.md`. Reports are never written inside a suite directory.
- Printed paths use `.botz/...` inside a repository and `~/.botz/...` outside one. The expanded path is never printed.

## What already does this job

| Piece | Where | What it does |
| --- | --- | --- |
| Full introspection | `introspectServer` in `src/engine/core/suite-introspect.ts` | Connects and pages `tools`, `resources`, resource templates, and `prompts` |
| Default suite | `buildDefaultSuiteNodes` in `src/engine/core/suite-model.ts` | One contract group: initialize, ping, each read-safe tool call, resource reads, prompt gets, teardown. Write-like tools are present and disabled |
| Compile | `compileSuite` | Suite nodes plus a load profile become a manifest the runner already executes |
| Run | `run` / `runManifest` | Executes a manifest. `run --manifest` writes JSON and Markdown under the runs directory |
| Substitution | `substituteValue` | Replaces `${name}` in step args. Built-ins `__uuid`, `__ts`, `__thread`, `__iter`, `__loop` stay reserved |

`discover` and `approve` are the older file path. `discover` lists tools only, and `approve` requires `--by <principal>`. Leave that path as it is.

`project add` and `project suite run` are the studio path. They write versioned projects under `.botz/mcp-swarm/data`, and a suite run loads org policy so the host must also be on the org allowlist. That coupling is what this mode avoids.

## Original gaps (resolved by the standalone implementation)

1. **No portable suite file.** A suite today is a project id plus a version under `.botz/mcp-swarm/data`. `exportSuiteManifest` bakes one manifest; it does not keep the suite editable or parameterised.
2. **No run parameters.** `VarContext.vars` starts as `{}` in `runManifest`. The only way a name gets a value is an `extract` step earlier in the same run. An unknown `${name}` becomes an empty string, so a missing parameter would call the tool with a blank argument.
3. **Allowlist is a second copy of the host.** Every target must appear in `manifest.allowlist`, and project runs also check org policy. For this mode the URL or command the operator typed is the consent.
4. **Policy and identity leak in.** `project suite run` calls `loadPolicy()` and stamps `SWARM_PRINCIPAL` (default `cli`). `run` installs the local OTLP exporter from policy. None of that belongs on a file-only invocation.
5. **Sample args are not parameters.** `sampleArgsForTool` fills required fields with fixtures. Those fixtures need to be `${name}` tokens, with the sample value saved as the parameter's example.

Suites that call more than one server are described in [Multi-server suites](multi-server-suites.md).

## Suite directory

`capture` writes one directory. The suite file is the artifact; reports never live inside it.

```text
.botz/mcp-swarm/
  .gitignore      # config.json, runs/
  settings.json   # optional suitesDir / runsDir (committed)
  config.json     # literal target credentials per suite (mode 0600, not committed)
  runs/           # run reports (not committed)
  suites/demo/
    suite.json    # target, surface, nodes, load, parameter contract
    params.example.json
```

`suite.json`:

```json
{
  "kind": "botz-suite",
  "capturedAt": "2026-10-08T00:00:00.000Z",
  "name": "demo",
  "target": { "transport": "streamable-http", "url": "http://127.0.0.1:3000/mcp" },
  "surface": { "serverName": "", "capabilities": [], "tools": [], "resources": [], "prompts": [] },
  "nodes": [],
  "load": { "durationMs": 0, "maxConcurrency": 1, "iterations": 1 },
  "params": {
    "city": { "example": "NYC", "usedBy": ["n1"] }
  }
}
```

- `target` is stdio or an HTTP URL. It may carry `headers` (HTTP) or `env` (stdio), but only as references; see [Target credentials](#target-credentials). A stdio command or argument under the git root is stored relative to the git root.
- `surface` is the `ServerSurface` from `introspectServer`, so a later run does not need the server to rebuild the suite.
- `nodes` are the tree from `buildDefaultSuiteNodes`, with required tool and prompt arguments rewritten to `${param}`.
- `params` lists every token the nodes reference, minus the built-ins. `example` is the old sample fixture. `usedBy` is the node ids that reference it, so a hand edit can be checked.
- `params.example.json` is `{ "city": "NYC" }` and is safe to copy.

A parameter file is a flat string map. Captured examples are used automatically on `run --suite`, with values in the suite's `params.example.json` overriding embedded examples. Explicit `--params` values override those defaults; `--set city=SFO` overrides the file. Partial override files retain captured values for remaining parameters. Load knobs stay on the suite (`--iterations`, `--concurrency`) and are not mixed into tool arguments.

## Commands

### `capture`

```bash
botz mcp-swarm capture --url <url> [--name <name>] [--out <dir>] [target credential flags]
botz mcp-swarm capture --command <bin> [--arg <a>]... [--name <name>] [--out <dir>] [target credential flags]
```

1. Build a `Target` from the URL or command and the optional target credential flags. Move literal credentials to `config.json` and keep references in the target.
2. Call `introspectServer`.
3. Call `buildDefaultSuiteNodes`.
4. Walk sampler args. Each required string that `sampleArgsForTool` would have filled becomes `${param}`, and the fixture becomes `params.<name>.example`.
5. Write `suite.json` and `params.example.json`.
6. Print the tool count, the disabled write-like tools, the parameter names, the names (never the values) of credentials saved to `config.json`, and the suite path in its `.botz/mcp-swarm/...` or `~/.botz/mcp-swarm/...` form.

Capture does not call tools. It only lists and reads schemas.

### `run`

```bash
botz mcp-swarm run --suite <dir|name> [--params <file>] [--set k=v]... [target credential flags]
botz mcp-swarm run --suite <dir|name> --iterations <n> --concurrency <n>
```

1. Load `suite.json`. Reject anything other than `kind: "botz-suite"`.
2. Load captured parameter examples and the suite's `params.example.json`, then merge explicit `--params` and `--set` overrides into one string map.
3. Fail before connecting when a declared parameter is missing, or when an argument still contains an unknown `${name}`.
4. Resolve `${env:NAME}` references in the target. The environment wins over a value saved in `config.json`; a reference with neither fails with `missing credential: NAME`.
5. `compileSuite` with an empty allowlist, then `runManifest` with `vars` seeded from the map and `standaloneTarget: true`. That flag skips the target allowlist check, and the runner throws if an org allowlist is passed with it. No synthetic one-entry allowlist is built.
6. Write `botz-run-<timestamp>.json` and `botz-run-<timestamp>.md` in the runs directory and print their `.botz/...` paths. The report includes the parameter map, the suite's tool `catalog`, and `server` (name and version from the live `initialize` result, else the suite surface; transport; and the endpoint used, stripped of credentials and machine paths) so two runs can be compared. It has no `principal`.

The existing `run --manifest` stays. `--suite` and `--manifest` are mutually exclusive.

### `show`

```bash
botz mcp-swarm show --suite <dir|name>
```

Print the target, the enabled steps, and the parameter names. No network.

## Runner change

One change in `runManifest`, beside the empty `vars: {}` at the start of each iteration:

- Accept `options.vars?: Record<string, string>`.
- Copy it into `VarContext.vars` before the first step.
- When the caller passes a parameter contract, `substituteString` leaves unknown names unresolved and the step fails with the missing name. Callers that do not pass a contract keep today's empty-string behaviour, so manifests and project runs do not change.

Built-ins are applied after the seeded map, so a params file cannot override `__iter` or `__uuid`.

## Inferred test data and CLI inference

`capture` generates schema-checked arguments, positive/negative prompts, and assertions for enabled tools. Required string arguments become parameter examples. It fails on inference errors rather than saving a heuristic result. `run --suite` evaluates saved model prompts and assertions after the MCP steps, includes `toolEvals` in the report, and fails the overall run when evals fail. Inference is on by default; `--no-inference` selects schema-derived capture or an MCP-only run. See [CLI inference guide](mcp-inference-cli.md) for a complete workflow, API keys, and local model configuration.

## Auth and allowlist

The operator is anonymous. The target may need credentials.

- The operator is not a principal. Do not read `SWARM_PRINCIPAL`, do not append the audit log, and do not call `loadPolicy` or read role grants.
- Standalone mode does not use an allowlist. It does not read an org allowlist, a manifest allowlist, a hostname allowlist, or `policy.json`. The URL or command the operator typed is the only target consent. `standaloneTarget` is allowed only in the runner and the suite-file module; `pnpm check:no-bypass` fails anywhere else.
- Skip `installOtelExportTarget` unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set in the environment.

The studio path keeps its policy, principal, and allowlist gates. `capture` does not write `.botz/mcp-swarm/data`.

## Target credentials

`capture` and `run --suite` take five optional flags. They are credentials for the MCP server under test, and they are distinct from `SWARM_WORKER_TOKEN`, which only `worker` reads.

| Flag | Meaning |
| --- | --- |
| `--header <name:value>` | HTTP header. Repeat for each header |
| `--header-env <name=ENV>` | HTTP header read from the environment at connect time |
| `--bearer-env <ENV>` | `Authorization: Bearer` from that variable |
| `--env <key=value>` | stdio environment variable |
| `--env-from <key=ENV>` | stdio environment variable read from the environment at connect time |

- Every literal `--header` or `--env` value is saved to `config.json` under `suites.<id>.credentials (legacy unversioned suites use their name)`. `suite.json` keeps `${env:SWARM_TARGET_HEADER_<KEY>}` or `${env:SWARM_TARGET_ENV_<KEY>}` in its place. Only a value that is exactly `${env:NAME}` or `<scheme> ${env:NAME}` stays as typed. A literal `Authorization: Bearer <token>` keeps the scheme in `suite.json` and saves only the token.
- `<KEY>` is the header or env name upper-cased, with each run of characters outside `A-Z0-9` replaced by `_` and leading or trailing `_` trimmed. `X-Custom` becomes `SWARM_TARGET_HEADER_X_CUSTOM`; `DB_PASS` becomes `SWARM_TARGET_ENV_DB_PASS`. The service uses the same rule for worker assignments.
- Harmless headers such as `Accept` are moved too. Anyone who clones a suite must set a `SWARM_TARGET_HEADER_*` or `SWARM_TARGET_ENV_*` variable for every moved value, including `Accept`, or copy the matching `config.json` entry.
- API keys in the URL are refused by default. With explicit `--url-key-as-bearer` consent only, one query parameter named `api_key`, `apikey`, `api-key`, `x-api-key`, `subscription-key`, `ocp-apim-subscription-key` (or any name containing `subscription-key`), `key`, `token`, or `access_token` (any case) is removed from the URL and sent as `Authorization: Bearer`, saved as `SWARM_TARGET_HEADER_AUTHORIZATION`. The CLI prints the parameter name, never the value. Capture fails, without printing the value, when the URL also has an Authorization header or `--bearer-env`, more than one key parameter, or an empty key.
- Capture refuses any other credential-looking query parameter (for example `client_secret`, `password`, `private_key`, `session`, `sid`, `jwt`, `bearer`, `pass`, `hmac`, `code`, signatures), any credential in the URL fragment (`#access_token=...`, `#code=...`), and `user:password@` in the URL. Pagination and limit names such as `max_tokens`, `page_token`, and `nextPageToken` are kept. Pass credentials with `--header` or `--bearer-env`. `run --suite` repeats this check before connecting, including for hand-edited suites.

## stdio paths

- A stdio command or argument under the git root is stored relative to the git root and resolved against it at run time, so a suite captured in a subdirectory runs from any directory in the repository.
- Outside a repository, a path under the home directory is stored as `~/...` and expanded at run time; other paths are stored relative to the current directory.
- A `~/...` command outside the project still runs, because the operator typed it.

## Reports

`run --suite` reports and the lines it prints are safe to commit:

- Resolved header and env values, the credential after an auth scheme, values saved in `config.json`, and API-key or secret-named URL parameters and userinfo become `[redacted]`.
- A stdio command is recorded as its basename. The git root becomes `<repo>`, the current directory `<cwd>`, the home directory `~`, and any other absolute path its last segment. The OS username becomes `<user>`.
- Reports then pass through the shared redaction (`redactValue` / `redactString`).
- Limits: username scrubbing is a whole-word replace for names of three or more characters, so a very short username is not removed, and a username that is also a common word is replaced wherever it appears.

## Implementation slices (completed)

1. **Seeded vars.** Add `vars` to `RunOptions`. Copy them into `VarContext`. Add a contract-aware miss in `substituteString`. Unit tests: a seeded `${city}` reaches `tools/call` args; a missing name fails the step; `__iter` still wins over a param of the same name.
2. **Suite file.** Types, parse, and write for `suite.json` in `src/cli/suite-file.ts`. Rewrite sample args into `${param}` and collect the contract. Test with a fake surface, no network.
3. **`capture`.** Wire `introspectServer` and `buildDefaultSuiteNodes` to the file writer. Test against the mock server: directory appears, write-like tools are disabled, no tool call is recorded.
4. **`run --suite`.** Compile, seed, execute, write the report with the parameter map. Two invocations with different `--params` files produce two reports and do not touch `.botz/mcp-swarm/data` or `policy.json`.
5. **`show`.** Offline print of steps and parameter names.

## Out of scope

- Admin UI, projects, schedules, role grants, and the catalogue.
- OAuth flows against the target. Static headers, bearer tokens, and env values are supported; see [Target credentials](#target-credentials).
- Editing the suite tree from the CLI (`add-node`, move, enable). Hand-editing `suite.json` is enough; `show` is the check.
- Re-introspection that rewrites a saved suite in place.
- Description optimisation and A/B benches.

## Done when

- `capture` against the mock server writes a suite directory with no service process running.
- `run --suite` twice, with two parameter files, writes two reports whose call args differ and whose verdicts follow the mock.
- A missing parameter exits before any MCP call.
- A suite run does not create or read `.botz/mcp-swarm/data/policy.json`, and does not create `.botz/mcp-swarm/data`.
- Run reports contain no token, home path, repository path, or username.
- Existing `run --manifest` and `project suite run` tests stay green.


## Release-readiness additions

Capture refuses to overwrite either saved suite file unless `--force` is passed. New suites carry `schemaVersion: 1` and a stable credential ID; legacy files remain readable. Config updates use a lock and atomic rename. Stdio suites retain their capture working directory, including relative script/data arguments. Discovery rejects truncated pagination and advertised-list failures rather than saving partial coverage.

Use `suite list --json`, `suite validate --suite <name> --json`, and `doctor --suite <name> --json` for offline inspection. `doctor --inference` checks model configuration separately. Capture and run default to MCP-only operation and need no provider credentials. Add `--inference` explicitly to generate or evaluate model fixtures.

Standalone manifest and soak execution no longer reads service policy or saves `.botz/mcp-swarm/data` history. OTLP is disabled unless the endpoint is explicitly configured. Export failures are recorded without losing the test report.

## Unified standalone workflow

The CLI now groups saved-suite operations under `suite capture|show|list|validate|refresh|run`; existing top-level aliases remain supported. See the [CLI guide](../README.md#repeatable-standalone-workflows) for target overrides, duration/ramp controls, non-destructive refresh, JSON/JUnit output, and exit codes. Timed suite/soak runs share the load engine. Doctor, validation, and execution share configuration resolution.
