# MCP protocol eras (design)

swarm-cli speaks both MCP protocol eras so it can test any server.

| Era | Revision | How swarm connects |
| --- | --- | --- |
| Legacy | 2025-11-25 and earlier | `initialize` handshake, `Mcp-Session-Id`, standalone GET notification stream (SDK 1.x client) |
| Modern | 2026-07-28 | sessionless JSON-RPC: every request carries `_meta.io.modelcontextprotocol/{protocolVersion,clientInfo,clientCapabilities}` and the `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` headers; `server/discover` for identity and capabilities |

## Choosing an era

* Target field `protocolEra`: `auto` (default), `legacy` or `modern`.
  * `auto` sends `server/discover`. A `DiscoverResult` or a modern error
    (`-32022 UnsupportedProtocolVersion`) means modern; anything else falls back
    to the legacy `initialize`. The detected era is cached per HTTP origin+path for 10 minutes.
  * `modern` fails loudly when the server is not modern.
* Target field `suppressNotificationStream: true` (legacy only) skips the
  standalone GET notification stream, like MCP Inspector's option.
* Manifest/suite `protocolEra` pins every target, or `both` runs the suite once
  per era and diffs verdicts, per-step outcomes and tool-result digests
  (structuredContent, else content, ignoring `_meta`, `resultType` and
  time/id/trace/latency keys). Any divergence fails the run.
* `assertions.requireProtocolEra` fails a run that spoke a different era
  (catches a silent Auto fallback).
* CLI: `--protocol-era auto|legacy|modern|both` on `run`/`soak` (manifest or
  suite) and `auto|legacy|modern` on `discover`, `record`, `replay`, `optimize`.

Every report records `protocolEra`, `protocolEraRequested` and, on fallback,
`protocolEraFallback`; compare mode adds `eraComparison`.

## Gaps

* Modern era is Streamable HTTP only; stdio and HTTP+SSE stay legacy
  (`modern` pinned on them errors).
* No `subscriptions/listen`, MRTR (`input_required`) or `Mcp-Param-*` headers;
  `ping` and `logging/setLevel` steps report a protocol error on modern
  (removed in 2026-07-28).
* `--remote` runs use the server's target settings.
* Plan: move to `@modelcontextprotocol/client` 2.x when it can replace the
  hand-rolled modern client.
