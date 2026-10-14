# @zotoio/botz-mcp-swarm-cli

Standards-based MCP load testing for CI and local development. Measures **MCP operations** (not raw HTTP RPS) across stdio, SSE, and streamable HTTP transports. **Silent green = Fail.**

```bash
npm install -g @zotoio/botz-cli
botz plugins install mcp-swarm
botz plugins list
botz mcp-swarm --help
```

The user-facing command is `botz mcp-swarm [args]`. Both the [botz-cli](https://github.com/zotoio/botz-cli) host and this extension are TypeScript/Node packages requiring Node 22.13+. The host installs extensions into its managed directory, avoiding global npm/pnpm bin PATH problems. Use `botz plugins search`, `botz plugins info mcp-swarm`, and `botz plugins list --json` for discovery and installed versions. This extension does not own the `botz` executable. For standalone use, `npm install -g @zotoio/botz-mcp-swarm-cli` provides `botz-mcp-swarm` and the compatibility alias `swarm`. For an unpublished source revision, run `botz plugins install mcp-swarm --source --ref main`.

Source and releases live in [botz-mcp-swarm-cli](https://github.com/zotoio/botz-mcp-swarm-cli). The private swarm service remains in `botz-mcp-swarm`. The engine code needed for local execution is included in `src/engine`; this repository builds without access to the private service repository.

The CLI has two modes. Neither starts a server.

## Agent Skills (Cursor, Claude Code, Codex)

The MCP Swarm skills are published as the `botz-mcp-swarm` plugin in the
[zoto-agents](https://github.com/zotoio/zoto-agents/tree/main/plugins/botz-mcp-swarm)
marketplace, which is where they are maintained:

```text
Claude Code:  /plugin marketplace add zotoio/zoto-agents
              /plugin install botz-mcp-swarm@zoto-agents
Codex:        codex plugin marketplace add zotoio/zoto-agents
Cursor:       add zotoio/zoto-agents as a plugin marketplace, then install botz-mcp-swarm
```

The skills run when invoked by name (for example `/mcp-swarm`) and install the
`botz` host and this extension on first use if they are missing.

CLI 0.6.x bundled the skills and copied them into `.cursor/skills`,
`.claude/skills`, or `.agents/skills`. Remove those copies before installing the
plugin so agents do not discover the skills twice:

```bash
botz mcp-swarm skills status
botz mcp-swarm skills uninstall
```

Both accept `--agent`, `--scope user|project` (default `user`; use the scope of
the original install), and `--json`. Uninstall removes only unchanged copies;
edited ones are reported with exit 1 and left in place. `skills install` and
`skills update` now print the marketplace instructions and exit 1.

## Standalone suites

Save a suite from a live MCP server, then run it again with different parameters. No login, no allowlist, no org policy, and no role grant: the URL or command you type is the consent.

```bash
botz mcp-swarm suite capture --url http://127.0.0.1:3000/mcp --name demo
botz mcp-swarm suite show --suite demo
botz mcp-swarm suite run --suite demo
```

This first walkthrough needs only your MCP target, with no swarm service or model credentials. Captured parameter examples are used automatically; add `--set key=value` to override one. Inference is opt-in: add `--inference` to capture or run when you want model-generated fixtures or model evals. Existing `--no-inference` flags remain supported.

For a stdio server use `--command <bin> [--arg <a>]...` instead of `--url`.

- **Where files go.** Inside a git repository, suites are saved to `<repo>/.botz/mcp-swarm/suites/<name>/`, run reports to `<repo>/.botz/mcp-swarm/runs/`, and literal credentials to `<repo>/.botz/mcp-swarm/config.json`, where `<repo>` is the git root above the current directory. Outside a git repository the same layout lives under `~/.botz/mcp-swarm/`. Inside a repository, the repository's `.botz/mcp-swarm` takes precedence and `~/.botz/mcp-swarm` is a read-only fallback for settings, suite names, and credentials. Earlier `.botz/suites/` and `.botz/config.json` files are still read.
- **Directory settings.** `.botz/mcp-swarm/settings.json` may set `suitesDir` and `runsDir`, for example `{ "suitesDir": "qa/suites", "runsDir": "qa/runs" }`. Relative paths resolve from the git root (from home for `~/.botz/mcp-swarm/settings.json`); `~/` and absolute paths also work. `capture --out <dir>` and `run --output <dir>` override them for one command. `--suite` takes a directory or a suite name.
- **Upgrading.** `upgrade` previews moving files from earlier layouts (`.botz/suites/`, `.botz/config.json`, `.runs/` and cwd reports, `.swarm-data/`, `.otel/`) into `.botz/mcp-swarm/`; `upgrade --apply` moves them, merging credentials without overwriting newer values. Targets that already exist are reported as conflicts and left alone (exit 1). Run it in each repository, and once outside any repository for `~/.botz`. The `mcp-swarm-upgrade` skill in the [botz-mcp-swarm plugin](#agent-skills-cursor-claude-code-codex) walks an agent through the whole upgrade, including git tracking and verification.
- **Safe recapture.** Existing suites are preserved unless `capture --force` is passed. Default HTTP names include a host and endpoint hash; explicit `--name` values stay readable. New suite files contain `schemaVersion: 1` and a credential ID; legacy unversioned files still load.
- **Reports.** `run --suite` writes `botz-run-<timestamp>.json` and `botz-run-<timestamp>.md` to the runs directory (or under `--output <dir>`). Reports and printed output contain no home directory, username, absolute path, token, header value, or secret environment value, so they are safe to commit. A stdio command is recorded as its basename.
- **Server.** Each report's `server` field records the server name and version from the run's `initialize` result (falling back to the suite's captured surface), the transport, and the `endpoint` actually used: the URL without userinfo, query, or fragment, or the stdio command and arguments with absolute paths reduced to their basename. A run with `--url` or `--target-file` therefore shows the endpoint it tested, not the one in `suite.json`. The Markdown header shows the server and endpoint. Suite-run reports also carry the suite's tool `catalog`, so `compare` treats a tool whose schema hash changed as `schema-changed` instead of scoring it.
- **Target credentials.** `--header <name:value>`, `--header-env <name=ENV>`, `--bearer-env <ENV>`, `--env <key=value>`, and `--env-from <key=ENV>` are optional credentials for the MCP server under test. They are not the worker token.
  - Literal values are saved by suite ID to `.botz/mcp-swarm/config.json` (mode 0600), using locked, atomic updates. `.botz/mcp-swarm/.gitignore` keeps `config.json` and `runs/` out of git and leaves `suites/` and `settings.json` committable.
  - `suite.json` keeps only references: `${env:NAME}` as you typed it, or `${env:SWARM_TARGET_HEADER_<KEY>}` / `${env:SWARM_TARGET_ENV_<KEY>}` for a moved literal. `<KEY>` is the header or env name upper-cased with other characters replaced by `_` (`X-Custom` becomes `SWARM_TARGET_HEADER_X_CUSTOM`). Every literal is moved, including harmless headers such as `Accept`.
  - At run time the environment wins over `config.json`. A teammate who clones a suite sets the matching `SWARM_TARGET_*` variables.
- **Credentials in the URL.** Query credentials are refused by default, because a query API key is not necessarily bearer authentication. Only when your server accepts bearer auth, pass `--url-key-as-bearer` to explicitly move one recognized API-key query parameter to an Authorization header. Other secret query parameters, fragments, and URL userinfo remain refused; use `--header` or `--bearer-env`. No automatic authentication conversion occurs.
- **stdio paths.** The capture working directory is stored portably along with command paths, so bare script arguments and relative data files resolve consistently when the suite runs from any directory in the repository. Outside a repository, a path under your home directory is stored as `~/...` and expanded at run time; such a command runs even though it is outside the project, because you typed it.

## Scan with inferred test data

Configure `SWARM_LLM_API_KEY` or `OPENAI_API_KEY`, then:

```bash
botz mcp-swarm suite capture --url http://127.0.0.1:3000/mcp --name inferred-demo --inference
botz mcp-swarm suite run --suite inferred-demo --inference
```

For stdio use `--command <bin> --arg <arg>` in place of the URL. Capture generates schema-checked arguments, positive/negative tool-use prompts, and assertions for enabled tools. Review the generated parameter examples before running. Saved-suite runs use them automatically; `--params` and `--set` override captured values. Generation errors fail capture; model eval failures fail the run. Inference is off by default; `--inference` enables it for that invocation. This scans the live MCP surface, not source code.

`SWARM_LLM_BASE_URL` selects an OpenAI-compatible API root (default `https://api.openai.com/v1`). For a running local model server, set it to e.g. `http://127.0.0.1:11434/v1`, set `SWARM_LLM_MODEL` to an installed model supporting tool calls and JSON output, and select `SWARM_LLM_PROVIDER=ollama` (no key needed). Leave `TYPESAFE_API_KEY` empty to judge assertions on the same endpoint. The CLI does not start a model server. Model configuration loads from the shell or `.env.local` / `.env` in the current directory, with shell values taking precedence.

Reports include `toolEvals` and the combined pass/fail verdict. `--inference` on run requires `--suite`. For full instructions see the [CLI inference guide](https://github.com/zotoio/botz-mcp-swarm-cli/blob/main/docs/mcp-inference-cli.md).

## Repeatable standalone workflows

Use `suite capture|show|list|validate|refresh|run` for saved suites. Top-level `capture`, `show`, and `run --suite` remain available.

```bash
# Reuse the same assertions against another environment.
botz mcp-swarm suite run --suite demo --url https://staging.example/mcp --bearer-env STAGING_TOKEN
# A complete replacement target, including stdio or SSE, can live in a separate JSON file.
botz mcp-swarm suite run --suite demo --target-file targets/local.json
# Sustained load with gradual startup and draining.
botz mcp-swarm suite run --suite demo --duration-ms 30000 --concurrency 4 --ramp-up-ms 2000 --ramp-down-ms 1000
# Inspect server changes, then apply while preserving edits.
botz mcp-swarm suite refresh --suite demo --dry-run
botz mcp-swarm suite refresh --suite demo
# CI stdout contains only the chosen result format.
botz mcp-swarm suite run --suite demo --format json > result.json
botz mcp-swarm suite run --suite demo --format junit > junit.xml
```

Target overrides apply only to that invocation and never modify the saved suite. `--url` retains the HTTP transport but replaces all headers; `--target-file` replaces the complete target. Neither inherits saved credentials. Supply credentials explicitly using environment references or auth flags. Relative stdio paths in target files resolve against the invocation's working directory. Doctor and validation accept the same target overrides.

Suite execution always uses the load engine, including iteration-only runs, so `--concurrency` and `--iterations` work together. `--iterations` is a minimum per virtual user; duration may cause additional passes. Duration is the hold period; ramp-up, ramp-down, and in-flight work add elapsed time. `--dwell-ms` controls time between steps and `--jitter-ms` between passes. `soak --suite demo` and `suite run --suite demo --soak` use this same engine with a default 5000ms hold and report mode `load`. Manifest soak retains its existing iteration limit semantics.

Refresh contacts the MCP server, without model calls or tool execution. It reports added, removed, and changed tools/resources/prompts/capabilities. Existing node IDs, custom arguments, assertions, load settings, and parameter files are retained. Removed steps remain disabled for review. New steps use schema defaults; write-like tools remain disabled. Schema changes are reported but do not rewrite your assertions—review and update affected steps before running. Dry-run writes nothing.

`--format text|json|junit` works with suites and manifests. JSON and Markdown report files are still written. JUnit includes aggregate verdict failures such as SLO failures. Run exit codes are 0 for pass, 1 for a failed verdict, 2 for configuration/execution errors, 130 for SIGINT, and 143 for SIGTERM. Validation errors include field paths; missing credentials identify the environment-variable name without its value.

## Offline diagnostics

```bash
botz mcp-swarm suite list --json
botz mcp-swarm suite validate --suite demo --json
botz mcp-swarm doctor --suite demo --output ./reports --json
botz mcp-swarm doctor --inference
```

These commands do not contact target or model servers. Validation checks suite structure and parameter examples; doctor checks credential references, executable availability, and output permissions. A failed validation/check exits 1.

## Tool description proposals

```bash
botz mcp-swarm optimize --target '{"transport":"stdio","command":"node","args":["server.js"]}' --allowlist stdio --tool search_docs
botz mcp-swarm optimize --target-file target.json --allowlist api.example.com --tool search_docs
```

`optimize` reads one tool from the live `tools/list` (`--tool` is required) and proposes a clearer description from its current description, input schema, and parameter descriptions. It never calls the tool. With an inference provider configured, a model drafts the rewrite; otherwise a heuristic reports concrete gaps (missing or very short description, undocumented parameters, required parameters the description does not mention) and drafts a description only when the current one is missing or very short. Proposals are saved as drafts under `.botz/mcp-swarm/data/` and need an explicit Accept.

`optimize` does not measure whether a proposal is better. To compare, run tool evals before and after applying the new description on the server: `suite run --suite <name> --inference` sends fixed prompts against the live server's descriptions, so the change in eval pass rate shows the effect.

## Worker mode (opt-in)

A worker runs suites assigned by a botz mcp-swarm service. It dials out and does not listen on a port.

```bash
export SWARM_WORKER_TOKEN=<worker-token>
botz mcp-swarm worker --server https://swarm.example.com
```

| Flag or variable | Meaning |
|------------------|---------|
| `--server <baseUrl>` | Service origin. A URL with `user:password@` is refused |
| `--token <token>` / `SWARM_WORKER_TOKEN` | Worker token from a service admin. `--token` wins when both are set |
| `--transport auto\|http2\|sse` | `auto` (default) tries HTTP/2 first and falls back to SSE |
| `--allow-stdio` | Off by default. A stdio target starts a local command chosen by the service, so stdio assignments are rejected unless you opt in |
| `--base-dir <dir>` | Directory that relative stdio commands resolve against. Defaults to the current directory |

Each assignment lists the environment variables the worker needs: `${env:NAME}` references stored on the target, and `SWARM_TARGET_HEADER_<KEY>` / `SWARM_TARGET_ENV_<KEY>` for values the service will not send. Set each to the full value, scheme included (`SWARM_TARGET_HEADER_AUTHORIZATION="Bearer <token>"`). A missing variable rejects the run with `missing credential: NAME`. A revoked or unknown token stops the worker with exit 1; other disconnects reconnect with backoff.

## Manifests

```bash
botz mcp-swarm run --manifest manifest.json
botz mcp-swarm soak --manifest manifest.json --duration-ms 5000
botz mcp-swarm compare --base base.json --head head.json
```

`compare` prints each side's server and endpoint and, when both reports record a server, warns if the server name, transport, or endpoint differs. A different server version is not a warning. The warnings are also in the `--output` JSON under `warnings`; they do not change the exit code.

`run --manifest` writes reports under `.botz/mcp-swarm/runs/` (or the configured `runsDir`) unless `--output` is set. On **Pass** the exit code is `0`; on **Fail** (including silent green), invalid input, or configuration errors it is `1`. Standalone manifest/soak runs only write requested reports; they do not use `.botz/mcp-swarm/data` or service policy. Telemetry is off unless `OTEL_EXPORTER_OTLP_ENDPOINT` is explicitly configured. Reports distinguish disabled, configured, delivered, and failed export states; telemetry failure does not discard test results.

On standalone runs, SIGINT requests cancellation and exits 130; SIGTERM exits 143. The runner closes MCP sessions and writes the available report. A second signal forces immediate exit. A model SDK operation already in flight may take time to finish.

## License

MIT

## Inference providers

Inference is opt-in for capture and saved-suite runs; pass `--inference`. Set `SWARM_LLM_PROVIDER` to `openai`, `anthropic`, `gemini`, `openrouter`, `groq`, `deepseek`, `mistral`, `together`, `xai`, `ollama`, `cursor`, or `custom`. Standard keys are `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` / `GOOGLE_API_KEY`, `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `DEEPSEEK_API_KEY`, `MISTRAL_API_KEY`, `TOGETHER_API_KEY`, `XAI_API_KEY`, optional `OLLAMA_API_KEY`, and `CURSOR_API_KEY`, respectively. `SWARM_LLM_API_KEY` explicitly overrides the selected provider key. A single recognized key auto-selects its platform; multiple keys require an explicit provider.

Set `SWARM_LLM_MODEL` for non-OpenAI providers; Cursor defaults to `auto`. For Ollama, select an installed tool/JSON-capable model: no dummy key is required and the API root defaults to `http://127.0.0.1:11434/v1`. Custom compatible providers need `SWARM_LLM_BASE_URL` and a key. Cursor uses the official `@cursor/sdk` for generation, judging, and real MCP execution. Set `SWARM_CURSOR_RUNTIME=local` (default) or `cloud`; cloud requires a remote endpoint exposing only enabled tools. See the inference guide for runtime details. Credentials are supplied by you; the CLI does not import keys from Cursor settings.

## Development and releases

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm check:cli-pack --no-build
# Run without the host installed:
node dist/cli.js --help
```

The extension protocol is described in [docs/plugin-contract.md](docs/plugin-contract.md).
CI validates the package and installs the exact tarball on Linux, macOS, and Windows.
Releases publish that validated artifact using npm trusted publishing. Configure the
npm trusted publisher for organization `zotoio`, repository `botz-mcp-swarm-cli`,
and workflow `publish.yml` with direct publishing allowed. A pushed `v<version>` tag
matching `package.json` triggers validation and publishing. Stable versions use
`latest`; prereleases use `next`. See [RELEASING.md](RELEASING.md).
The `botz` host is separately versioned and published by [botz-cli](https://github.com/zotoio/botz-cli).

### Run configuration defaults

New load-test configurations start with a 30-second hold, 5-second ramp-up,
one virtual user, one lane, one required pass, 100 ms between steps, and up to
100 ms jitter between passes. In-flight passes get a maximum 60-second drain
allowance after the hold; a run finishes immediately once its work completes.

CLI capture creates a single-pass smoke configuration instead: duration, ramp-up,
dwell, and jitter are zero, with the same 60-second drain allowance ready for
later timed runs. Saved values and CLI overrides, including explicit zero, take
precedence. Existing suites are not rewritten. For an older suite with zero drain,
set `load.rampDownMs` to `60000`, or use `--ramp-down-ms 60000` for one run.
Longer multi-step or inference workloads may need a larger allowance; exceeding
the configured drain deadline still fails the unfinished pass.
