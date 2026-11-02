# Suite lifecycle hooks (setup / teardown)

Any step can carry `hook: "setup" | "teardown"`.

| Where the step sits | Scope | Runs |
|---|---|---|
| Top level of the suite | Suite hook | Once per run: setup runs before every scenario, teardown runs after all of them |
| Inside a scenario frame | Scenario hook | On every pass of that scenario: setup runs before the body, teardown runs after it |

## Rules

- **Setup** steps run in order. If a setup step fails, the steps that depend on it are skipped. If suite setup fails, every scenario is skipped, and the report says `Suite setup failed: …`.
- **Teardown** always runs, even after a failure, a drain, or Stop. Teardown errors go into `report.hookErrors` and the run log. They never fail the verdict, and they are left out of the fail reasons and the SLO checks.
- Keep hook steps **idempotent**, for example "ensure fixture exists", so it is safe to re-run them.
- In the compiled manifest, suite hooks appear as `manifest.setup` / `manifest.teardown`. Scenario hooks stay in `steps`, tagged with `hook` and `scenarioId`.

## Generation and update-from-server

- A tool whose name or description reads like *ensure/seed/setup … fixture*, and that is not destructive, gets proposed as a **suite setup** step.
- A tool that reads like *cleanup/purge … test assets*, or a `*_run_completed` tool, gets proposed as a **suite teardown** step.
- When an existing body step uses one of these tools, the update proposes `set-hook` and lifts the step to the top level.
- If a cleanup step stays in the body, a `Re-ensure: <tool>` copy of the setup step is inserted right after it, so later steps still find their fixtures.

## Editing hooks

- **UI:** use +Step → *Setup step* / *Teardown step*. Or pick a step and set *Lifecycle hook* in the editor. The list view shows *Suite setup* / *Scenario teardown* badges and orders steps setup, then body, then teardown. On the canvas, the step subtitle starts with SETUP / TEARDOWN.
- **MCP:** `swarm_suite_hooks` with `action: list | add | set`.
- **CLI:** `project suite add-node … --hook setup|teardown` and `project suite set-node … --hook setup|teardown|none`.
