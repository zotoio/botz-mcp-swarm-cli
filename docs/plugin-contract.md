# botz MCP Swarm extension contract

- Host command: `botz`; currently provided by `botz-mcp`, planned for the separate `botz-cli` repo.
- Extension source: public `zotoio/botz-mcp-swarm-cli`.
- Extension npm package: `@zotoio/botz-mcp-swarm-cli`.
- Invocation: `botz mcp-swarm [args]`.
- Executable discovered on PATH: `botz-mcp-swarm` (not `botz-mcp-swarm-cli`).

The host resolves the executable, sets `BOTZ_PLUGIN=mcp-swarm`, and forwards only
`[args]`, preserving argument boundaries, working directory, environment, signals,
and exit status. The extension displays `botz mcp-swarm` in its help when launched
with that environment marker. The host owns plugin discovery; the extension does
not parse a second `mcp-swarm` argument or install a replacement `botz` executable.

Direct execution via `botz-mcp-swarm [args]` remains useful for troubleshooting.
`swarm` is a compatibility alias. No service is started by either entry point.
The future host repo can keep this executable protocol without changing the extension.
