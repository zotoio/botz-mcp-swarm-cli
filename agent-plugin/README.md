# MCP Swarm agent plugin

Portable Agent Skills for capturing, running, and diagnosing MCP test suites.
Requires Node.js 22.13+ and npm. The skills run every command as
`botz mcp-swarm`. If the `botz` host is missing they install it, and then the
mcp-swarm extension, on first use:

```sh
npm install -g @zotoio/botz-cli
botz plugins install mcp-swarm
```

This directory is a self-contained plugin. `plugin.json` follows Agent Plugins
1.0; `.cursor-plugin/plugin.json` and `.claude-plugin/plugin.json` provide native
compatibility. All formats discover the same `skills/` content. There is no MCP
server or executable bundled in this plugin.

## Add to a marketplace monorepo

Copy this entire directory, including dot directories, to
`plugins/botz-mcp-swarm/` in your marketplace repository. Merge the entry from
`marketplace-entry.json` into the `plugins` array in either
`.cursor-plugin/marketplace.json` or `.claude-plugin/marketplace.json`.
A minimal complete marketplace manifest for either client is:

```json
{
  "name": "zotoio-tools",
  "owner": { "name": "zotoio" },
  "plugins": [
    { "name": "botz-mcp-swarm", "source": "./plugins/botz-mcp-swarm" }
  ]
}
```

Use a different `source` if your monorepo uses a different folder layout. Paths
are relative to the marketplace repository root. Keep the plugin's skills and
manifests together; copying only the manifest is insufficient.

For an OpenAI local marketplace, use `.agents/plugins/marketplace.json` and the
entry in `marketplace-entry.openai.json` instead; its source and policy format
differs from Cursor and Claude Code.

Install through the client's marketplace UI. In Claude Code, after publishing
the marketplace repository, users can run:

```text
/plugin marketplace add <owner>/<marketplace-repo>
/plugin install botz-mcp-swarm@zotoio-tools
```

Refresh the copied plugin from a CLI release to publish updated instructions.
Manifest versions must match that release's package version. Plugin updates do
not upgrade the CLI. Avoid installing CLI-managed copies for the same client:
plugin skills and local skills can both appear in discovery.

## Install skills directly instead

```sh
botz mcp-swarm skills install --agent cursor --agent claude-code
botz mcp-swarm skills status
botz mcp-swarm skills update
```

These commands use bundled files offline. Updates are explicit; no scheduler,
background updater, or npm lifecycle installation hook is registered.

References: [Agent Skills](https://agentskills.io/specification),
[Agent Plugins](https://agent-plugins.org/),
[Cursor plugins](https://cursor.com/docs/reference/plugins),
[Claude Code marketplaces](https://code.claude.com/docs/en/plugin-marketplaces).
