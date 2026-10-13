---
name: mcp-swarm-upgrade
description: Upgrade the botz MCP Swarm CLI and move saved suites, credentials, run reports, and service state into the current layout. Use when updating MCP Swarm, after release notes mention moved files, or when old .botz/suites, .runs, .swarm-data, or .otel directories are present.
license: MIT
disable-model-invocation: true
compatibility: Requires Node.js 22.13+, npm, and shell access. Installs the botz host (@zotoio/botz-cli) and its mcp-swarm extension if missing. The upgrade command needs mcp-swarm 0.6.1 or later.
metadata:
  author: zotoio
  cli-host: "@zotoio/botz-cli"
  cli-package: "@zotoio/botz-mcp-swarm-cli"
---

# Upgrade MCP Swarm

Work through the steps in order and stop to ask the user before anything the CLI reports as a conflict.

## 0. Setup

Run every command through the botz host as `botz mcp-swarm`. Do not use the standalone `botz-mcp-swarm` or `swarm` executables. Before the first command in a session:

1. Run `botz --version`. If `botz` is not found, check `node --version` (22.13 or later is required), then install the host with `npm install -g @zotoio/botz-cli` and tell the user you installed it. If Node is too old or the global install fails, for example with a permissions error, stop and report it; do not use `sudo` or change npm configuration.
2. Run `botz plugins info mcp-swarm --json`. If `installedVersion` is `null`, run `botz plugins install mcp-swarm`.
3. Confirm with `botz mcp-swarm --version`, and check the relevant subcommand's `--help` before using unfamiliar options.

## 1. Check versions

```sh
botz plugins info mcp-swarm --json
npm view @zotoio/botz-mcp-swarm-cli version
botz --version
npm view @zotoio/botz-cli version
```

Read the release notes between the installed and latest versions in the package `CHANGELOG.md` (https://github.com/zotoio/botz-mcp-swarm-cli/blob/main/CHANGELOG.md). Note any moved files, changed defaults, and removed flags before changing anything.

## 2. Update the CLI

```sh
npm install -g @zotoio/botz-cli@latest   # only if the host is behind
botz plugins install mcp-swarm           # add --version <v> to pin
botz mcp-swarm --version
```

Do not install `next` or prerelease versions unless the user asks. If a standalone `@zotoio/botz-mcp-swarm-cli` is also installed globally (`npm ls -g @zotoio/botz-mcp-swarm-cli`), tell the user it is no longer used by these skills; do not uninstall it without asking.

## 3. Preview the file moves

Stop any running MCP Swarm dashboard service first; it holds the service state that may move. Then, from inside each repository that uses MCP Swarm:

```sh
botz mcp-swarm upgrade --json
```

`upgrade` only previews unless `--apply` is passed. Each action lists the migration `step`, the release it arrived in (`since`), and display paths `from` and `to`. States are `pending`, `applied`, or `conflict`. Explain the pending moves to the user in plain terms. A `merge` action folds old literal credentials into `.botz/mcp-swarm/config.json`; values already in the new file win. Never print credential values.

A `conflict` means the target already exists. Do not delete either copy yourself. Show the user both paths, help them compare (for suites, `suite validate` and a diff of `suite.json`), and let them choose which to keep.

Inside a repository, `upgrade` handles that repository's `.botz` and its own report and service directories. For the per-user `~/.botz` layout, run it again from a directory that is not inside any git repository. Outside a repository it scans only the current directory for old reports and service state, never home itself.

## 4. Apply

```sh
botz mcp-swarm upgrade --apply
```

Exit codes: 0 when everything applied or nothing was needed, 1 when conflicts remain, 2 for errors. Running it again is safe; finished moves are not repeated.

## 5. Fix git tracking

Suites are committed files, so moving them shows up as deletions and additions:

```sh
git status
git add -A .botz
git check-ignore -v .botz/mcp-swarm/config.json .botz/mcp-swarm/runs/ .botz/mcp-swarm/data/ .botz/mcp-swarm/otel/
```

The CLI writes `.botz/mcp-swarm/.gitignore`, which keeps credentials, reports, service state, and OTLP data out of git and leaves `suites/` and `settings.json` committable. Confirm nothing under those ignored paths is staged. If reports were committed in the old layout, they are now ignored; ask before removing them from history.

Then search the repository for old paths in CI workflows, scripts, and docs, and update them:

```sh
git grep -n -e '\.runs/' -e 'botz-run-' -e '\.swarm-data' -e '\.otel/' -e '\.botz/suites' -e '\.botz/config.json'
```

To keep suites or reports somewhere else, set `suitesDir` or `runsDir` in `.botz/mcp-swarm/settings.json` instead of passing `--out` or `--output` everywhere. Repository settings take precedence over `~/.botz/mcp-swarm/settings.json`.

## 6. Refresh skills

```sh
botz mcp-swarm skills status
botz mcp-swarm skills update --scope project   # or --scope user, matching the original install
```

Locally edited skills are preserved and reported; leave them unless the user wants them replaced. Ask the user to reload their agent afterwards.

## 7. Verify

```sh
botz mcp-swarm suite list --json
botz mcp-swarm suite validate --suite <name> --json
botz mcp-swarm doctor --suite <name> --json
```

Every previously saved suite should be listed and valid. Only run a suite against a target the user is authorized to test; when they do, the report path printed should be under `.botz/mcp-swarm/runs/` (or the configured `runsDir`). Summarize what moved, what conflicts remain, and any paths still to update by hand.

## Layout changes by release

| Release | Change | `upgrade` step |
| --- | --- | --- |
| 0.6.0 | Suites `.botz/suites/` → `.botz/mcp-swarm/suites/` | `legacy-suites` |
| 0.6.0 | Credentials `.botz/config.json` → `.botz/mcp-swarm/config.json` (merged) | `legacy-credentials` |
| 0.6.0 | Skill records `.botz/skill-installations.json` → `.botz/mcp-swarm/` | `legacy-skill-registry` |
| 0.6.0 | Reports from the cwd and `.runs/` → `.botz/mcp-swarm/runs/` | `legacy-reports` |
| 0.6.1 | Service state `.swarm-data/` → `.botz/mcp-swarm/data/`, OTLP `.otel/` → `.botz/mcp-swarm/otel/` | `service-state` |

The CLI still reads suites and credentials from the 0.5 locations, so an un-migrated project keeps working, but new files go to the new layout.
