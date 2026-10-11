# Scan an MCP server with CLI inference

The CLI scans a live MCP server's tools, resources, and prompts. It does not scan source code. For a server in a local repository, run from that repository and supply its stdio launch command. An HTTP target must already be running.

## Capture inferred test data and run it

These inference flags are implemented in this checkout and have not been published as part of this change. Build with `pnpm build` and use `pnpm swarm` from this workspace instead of `botz-mcp-swarm`. Once a release includes the flags, install with `pnpm add -g @zotoio/botz-mcp-swarm-cli`.

```bash
# Set OPENAI_API_KEY securely in your shell or gitignored .env.local.
# Select a different provider using SWARM_LLM_PROVIDER if needed.
botz mcp-swarm capture --url http://127.0.0.1:3000/mcp --name demo --inference
botz mcp-swarm show --suite demo
botz mcp-swarm run --suite demo --inference
```

For stdio, replace capture's URL with your server's actual launch command:

```bash
# Run from the server repository after building it.
botz mcp-swarm capture --command node --arg dist/server.js --name demo --inference
```

`capture --inference` generates synthetic tool arguments, positive/negative tool-selection prompts, and assertions for each enabled tool. Arguments must pass the tool's input schema. Invalid JSON, arguments, or missing evals receive one model repair attempt with validation feedback; capture fails if the correction is still invalid. Missing keys, invalid output, schema violations, and model errors fail capture instead of saving heuristic data as an inferred suite. Tool names indicating create, update, push, fork, merge, add, set, remove, close, reopen, submit, or approve operations are classified as write-like, as are delete/write/mutate/destroy names. They remain disabled unless read-only annotations explicitly classify the tool otherwise. Disabled tools retain defaults and stay disabled. Resources and prompts retain schema-derived fixtures.

Generated evals and arguments are saved in `suite.json`. Required string arguments become parameters; their inferred values go in `params.example.json`. Review the fixtures before running: a schema-valid value may reference a record your server does not have. A plain `run --suite <name>` uses captured values automatically: embedded examples, then the suite's `params.example.json`, then explicit `--params` values and `--set key=value` overrides. A partial override file retains captured values for other parameters. Edit the parameter file or use `--set key=value`. Evals keep their saved prompts and assertions when run parameters change; edit the eval text too when needed.

Capture introspects the MCP server and calls the model; it does not execute MCP tools. Running with `--inference` executes enabled MCP steps, then model tool-selection probes and assertion judging once per saved eval. Compatible API providers observe proposed model tool calls; Cursor SDK agents execute them against the real MCP server. Eval failures make the report fail and the CLI exit nonzero. Requested inference also fails if the suite has no enabled tool evals.

Inference is off by default. Pass `--inference` on capture to generate fixtures and on standalone `run --suite` to evaluate them. `--no-inference` remains supported. The inference options apply to `--suite`; manifest runs retain their existing behavior. Explicit inference flags on `run --manifest` are rejected.

## Local model inference

Use an OpenAI-compatible Chat Completions endpoint with function tools and JSON output, and an installed model that supports both. For Ollama, the compatible root is `http://127.0.0.1:11434/v1` and no API key is required ([Ollama compatibility documentation](https://docs.ollama.com/api/openai-compatibility)).

```bash
export SWARM_LLM_PROVIDER=ollama
export SWARM_LLM_MODEL='<installed-tool-capable-model>'
# Empty means assertions use the same local model, rather than hosted Jev.
export TYPESAFE_API_KEY=

botz mcp-swarm capture --url http://127.0.0.1:3000/mcp --name demo --inference
botz mcp-swarm run --suite demo --inference
```

The CLI does not install or start a model server. With a loopback model endpoint and `TYPESAFE_API_KEY` empty, generation, tool-use probes, and assertion judging use that endpoint. A remote MCP target or tools that call external services still generate their own network traffic.

## Configuration and reports

- `SWARM_LLM_API_KEY` is an explicit override for the selected provider; otherwise its standard provider key is used. Hosted providers require their own API key. Ollama needs no key; Cursor requires `CURSOR_API_KEY` (or the explicit generic override).
- `SWARM_LLM_BASE_URL` is the API root including `/v1`, not `/chat/completions`. The default is `https://api.openai.com/v1`. Generated fixtures, probes, LLM judging, and description optimization use this endpoint.
- `SWARM_LLM_MODEL` defaults to `gpt-5.4-nano` for OpenAI/custom and `auto` for Cursor. Other providers require an explicit available model (an installed model for Ollama). GPT-5 names use `max_completion_tokens` and `reasoning_effort: none`; other names use `max_tokens`.
- `TYPESAFE_API_KEY`, when set, sends assertion judging to hosted Jev. Generation and tool-selection probes still require the LLM key.
- `.env.local` and `.env` load from the current directory; existing shell values win. Start a new CLI invocation after changes. Parent-directory env files are not loaded automatically.
- Suites default to `.botz/suites/<name>/` at the git root, or `~/.botz/suites/<name>/` outside a repo. Adjust the parameter path accordingly. Literal MCP target credentials are separate from model keys and go in gitignored `.botz/config.json`.
- Reports default to `botz-run-<timestamp>.json` and `.md` in the cwd. JSON includes `toolEvals`, observed model calls, assertion judgments, and the overall verdict. Explicit `--output <dir>` uses the run ID as the report filename.

See [Standalone suite CLI](standalone-suite-cli.md) for storage, parameters, target credentials, and redaction.

## Provider configuration

Set `SWARM_LLM_PROVIDER` and populate that platform's own key in your shell or gitignored `.env.local`. The CLI never obtains keys from your account or copies secrets from Cursor settings. `SWARM_LLM_API_KEY` overrides the selected platform key; it is not automatically sent to other platforms. Set `SWARM_LLM_MODEL` to a model available to your account that supports tool use and JSON output.

Built-in providers and recognized key variables:

- `openai`: `OPENAI_API_KEY`.
- `anthropic`: `ANTHROPIC_API_KEY`, through [Anthropic's compatible API](https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk). Its JSON-format field is ignored by the platform; the CLI validates returned JSON and inferred args itself.
- `gemini`: `GEMINI_API_KEY` or `GOOGLE_API_KEY`, through [Gemini's compatible API](https://ai.google.dev/gemini-api/docs/openai).
- `openrouter`: `OPENROUTER_API_KEY`, using [OpenRouter](https://openrouter.ai/docs/quickstart).
- `groq`: `GROQ_API_KEY`, using [Groq compatibility](https://console.groq.com/docs/openai).
- `deepseek`: `DEEPSEEK_API_KEY`, using [DeepSeek](https://api-docs.deepseek.com/).
- `mistral`: `MISTRAL_API_KEY`, using [Mistral chat](https://docs.mistral.ai/api).
- `together`: `TOGETHER_API_KEY`, using [Together compatibility](https://docs.together.ai/docs/inference/openai-compatibility).
- `xai`: `XAI_API_KEY`, using [xAI inference](https://docs.x.ai/developers/rest-api-reference/inference).
- `ollama`: local root defaults to `http://127.0.0.1:11434/v1`; no key required. `OLLAMA_API_KEY` is optional for an authenticated deployment.
- `cursor`: `CURSOR_API_KEY`, using the official Cursor SDK described below.
- `custom`: set `SWARM_LLM_BASE_URL`, `SWARM_LLM_MODEL`, and `SWARM_LLM_API_KEY` (or `OPENAI_API_KEY`) for another OpenAI-compatible service. APIs requiring native signed requests, such as AWS Bedrock, need a compatible gateway.

With no explicit provider or API-root override, a single recognized provider key selects its platform. Multiple platform keys require `SWARM_LLM_PROVIDER` so the CLI cannot accidentally route the wrong credential. A generic key alone retains the OpenAI default. An explicit base URL without a provider selects `custom`. Missing keys or model configuration fail inferred capture and inference runs; there is no silent fallback to a different provider.

For Cursor:

```bash
export SWARM_LLM_PROVIDER=cursor
# Set CURSOR_API_KEY securely; default model is auto.
# Unset SWARM_LLM_BASE_URL: Cursor uses its SDK, not an HTTP inference URL.
botz mcp-swarm capture --url http://127.0.0.1:3000/mcp --name demo --inference
botz mcp-swarm run --suite demo --inference
```

Cursor uses the official [`@cursor/sdk`](https://cursor.com/docs/sdk/typescript) for structured fixture creation and assertion judging, and for executing tool-use evals against the real MCP server. Node 22.13 or later is required. No separate Cursor CLI installation is needed.

Set `SWARM_CURSOR_RUNTIME=local` (default) or `cloud`. Local agents use an isolated temporary workspace, disable ambient settings, and expose only enabled suite tools through SDK callbacks connected to the real MCP session. Generation and judging have no local tools. SDK agents are disposed after each turn and timed-out runs are cancelled.

Cloud agents require a remotely reachable HTTP/SSE MCP endpoint exposing only the suite's enabled tools. Local stdio and loopback endpoints are rejected. Cloud tool events provide observed arguments and results; failed, unrecognized, or truncated events fail the eval. Cloud does not support the local tool allowlist, so its built-in tools and project/team/plugin settings remain governed by Cursor's cloud environment. Use a dedicated test endpoint and cloud workspace. Optional `SWARM_CURSOR_REPO` and `SWARM_CURSOR_REF` configure a cloud repository; no-repository cloud runs require account access to that feature. Automatic PR creation is disabled.

Cursor local agents execute on your machine while model inference remains hosted by Cursor. Use Ollama for entirely local model inference. Other compatible providers measure proposed function calls; the Cursor SDK path executes actual MCP calls and includes their results in assertion judging.

## Verified Parallel example

With `OPENAI_API_KEY` populated in the environment, this workflow was verified on 2026-10-11 against Parallel's anonymous Search MCP endpoint:

```bash
export SWARM_LLM_PROVIDER=openai
export SWARM_LLM_MODEL=gpt-5.4-nano
export TYPESAFE_API_KEY=
pnpm swarm capture --url https://search.parallel.ai/mcp --name parallel
pnpm swarm run --suite parallel --iterations 1 --concurrency 1
```

Clear `SWARM_LLM_BASE_URL` and `SWARM_LLM_API_KEY` if they are set for another provider. The verified capture inferred fixtures for `web_search` and `web_fetch`; the final run passed direct MCP checks and all four positive/negative model evals. An initial run failed inconsistent generated assertions, exposing the need for self-contained prompts and concrete required arguments; those failures remain in the local reports. Model-generated fixtures still require review and schema validation does not guarantee useful assertions or executable code. Generation respects described function entrypoints and requests behavioral assertions instead of incidental log labels or formatting. Application-error messages appear in failed step reports, with inline executable data URLs removed.
