import type { Command } from "commander";
import {
  formatUpdateCheck,
  parseTagList,
  projectAcceptServerUpdate,
  projectDescribe,
  projectDiscardServerUpdate,
  projectEditChangelogNotes,
  projectRefreshServer,
  projectIntrospectionStatus,
  formatIntrospectionStatus,
  projectScenarioRows,
  projectServerChangelog,
  projectServerUpdates,
  projectSuiteRows,
  projectTag,
} from "./server-update-ops.js";

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

/** `project server updates|accept-update|discard-update|changelog|describe`, `project suite describe|tag|list`, `project scenarios`, `project scenario tag`, `project run tag`. */
export function registerServerUpdateCommands(project: Command, server: Command, suite: Command): void {
  server
    .command("updates")
    .description("Check for server updates: re-probe serverInfo, MCP protocol version, capabilities and every primitive schema, and diff against the stored snapshot")
    .argument("<project>", "Project id or name")
    .option("--server <id>", "Server id or name. Defaults to every server")
    .option("--json", "Print JSON")
    .action(async (ref: string, opts: { server?: string; json?: boolean }) => {
      const { results } = await projectServerUpdates(ref, opts.server);
      if (opts.json) printJson(results);
      else console.log(formatUpdateCheck(results));
      if (results.some((r) => r.error)) process.exitCode = 1;
    });

  server
    .command("refresh")
    .description("Refresh from server: live-introspect now, record last-introspected time, snapshot hash, MCP spec version and protocol era, and flag drift between the server and the suites for review (never applied)")
    .argument("<project>", "Project id or name")
    .option("--server <id>", "Server id or name")
    .option("--suite <id>", "Suite id or name: refresh the server that suite runs against")
    .option("--stale-hours <n>", "Staleness threshold in hours (default SWARM_INTROSPECTION_STALE_HOURS or 24)")
    .option("--json", "Print JSON")
    .action(async (ref: string, opts: { server?: string; suite?: string; staleHours?: string; json?: boolean }) => {
      const hours = Number.parseFloat(opts.staleHours ?? "");
      const out = await projectRefreshServer(ref, { server: opts.server, suite: opts.suite }, Number.isFinite(hours) && hours > 0 ? { staleAfterMs: hours * 3_600_000 } : undefined);
      if (opts.json) printJson({ results: out.results, introspection: out.state });
      else console.log(`${formatUpdateCheck(out.results)}\n${formatIntrospectionStatus(out.state)}`);
      if (out.results.some((r) => r.error)) process.exitCode = 1;
    });

  server
    .command("status")
    .description("Show when each server was last live-introspected, its protocol era and MCP spec version, whether that is stale, and suite changes pending review")
    .argument("<project>", "Project id or name")
    .option("--server <id>", "Server id or name")
    .option("--suite <id>", "Suite id or name (its server only)")
    .option("--stale-hours <n>", "Staleness threshold in hours (default 24)")
    .option("--json", "Print JSON")
    .action(async (ref: string, opts: { server?: string; suite?: string; staleHours?: string; json?: boolean }) => {
      const hours = Number.parseFloat(opts.staleHours ?? "");
      const rows = await projectIntrospectionStatus(ref, { server: opts.server, suite: opts.suite, ...(Number.isFinite(hours) && hours > 0 ? { staleAfterMs: hours * 3_600_000 } : {}) });
      if (opts.json) printJson(rows);
      else console.log(formatIntrospectionStatus(rows));
      // Non-zero when anything is stale, so scripts can gate on it.
      if (rows.some((r) => r.stale)) process.exitCode = 2;
    });

  server
    .command("accept-update")
    .description("Accept a pending server update: update only the affected suites and record a changelog entry")
    .argument("<project>", "Project id or name")
    .option("--server <id>", "Server id or name. Defaults to the first server")
    .option("--change <id...>", "Proposal ids to accept (default: all)")
    .option("--notes <text>", "Changelog notes stored with the auto summary")
    .option("--json", "Print JSON")
    .action(async (ref: string, opts: { server?: string; change?: string[]; notes?: string; json?: boolean }) => {
      const result = await projectAcceptServerUpdate(ref, opts.server, { changeIds: opts.change, notes: opts.notes });
      if (opts.json) printJson(result);
      else {
        console.log(`Recorded ${result.annotation.id}: ${result.annotation.summary.split("\n").join("; ")}`);
        for (const v of result.suiteVersions) console.log(`  suite ${v.suiteId} → v${v.version}`);
        console.log(`  ${result.untouchedSuiteIds.length} suite(s) untouched`);
      }
    });

  server
    .command("discard-update")
    .description("Drop a pending server update without changing anything")
    .argument("<project>", "Project id or name")
    .option("--server <id>", "Server id or name. Defaults to the first server")
    .action(async (ref: string, opts: { server?: string }) => {
      console.log((await projectDiscardServerUpdate(ref, opts.server)) ? "Discarded." : "No pending update.");
    });

  server
    .command("changelog")
    .description("Show protocol versions, pending updates and changelog entries; with --entry and --notes, edit an entry's notes")
    .argument("<project>", "Project id or name")
    .option("--server <id>", "Server id or name")
    .option("--entry <id>", "Changelog entry id to edit")
    .option("--notes <text>", "Replacement notes")
    .option("--json", "Print JSON")
    .action(async (ref: string, opts: { server?: string; entry?: string; notes?: string; json?: boolean }) => {
      if (opts.entry) {
        const entry = await projectEditChangelogNotes(ref, opts.server, opts.entry, opts.notes ?? "");
        if (opts.json) printJson(entry);
        else console.log(`Updated notes on ${entry.id}`);
        return;
      }
      const rows = await projectServerChangelog(ref, opts.server);
      if (opts.json) return printJson(rows);
      for (const row of rows) {
        console.log(`${row.name} (${row.serverId}) · MCP ${row.protocolVersion ?? "unknown"} · v${row.serverVersion ?? "?"}${row.pending ? ` · PENDING (${row.pending.proposals} proposals)` : ""}`);
        if (row.description) console.log(`  ${row.description}`);
        for (const e of row.versionHistory) {
          console.log(`  ${e.recordedAt} ${e.id} ${e.previousServerVersion ?? "?"}→${e.serverVersion ?? "?"} MCP ${e.protocolVersion ?? "?"}`);
          console.log(`    ${e.summary.split("\n").join("\n    ")}`);
          if (e.notes) console.log(`    notes: ${e.notes}`);
        }
      }
    });

  server
    .command("describe")
    .description("Set a server's description (empty string clears it)")
    .argument("<project>", "Project id or name")
    .argument("<description>")
    .option("--server <id>", "Server id or name. Defaults to the first server")
    .action(async (ref: string, description: string, opts: { server?: string }) => {
      await projectDescribe(ref, "server", opts.server, description);
      console.log("Saved.");
    });

  suite
    .command("describe")
    .description("Set a suite's description (empty string clears it)")
    .argument("<project>", "Project id or name")
    .argument("<description>")
    .option("--suite <id>", "Suite id or name. Defaults to the first suite")
    .action(async (ref: string, description: string, opts: { suite?: string }) => {
      await projectDescribe(ref, "suite", opts.suite, description);
      console.log("Saved.");
    });

  suite
    .command("tag")
    .description("Replace a suite's tags (no tags clears them)")
    .argument("<project>", "Project id or name")
    .argument("[tags...]", "Tags (space or comma separated)")
    .option("--suite <id>", "Suite id or name. Defaults to the first suite")
    .action(async (ref: string, tags: string[], opts: { suite?: string }) => {
      const saved = await projectTag(ref, "suite", { id: opts.suite ?? "", tags: parseTagList(tags) });
      console.log(saved.length ? `Tags: ${saved.join(", ")}` : "Tags cleared.");
    });

  suite
    .command("list")
    .description("List suites with descriptions and tags")
    .argument("<project>", "Project id or name")
    .option("--tags <tags>", "Only suites carrying every one of these comma-separated tags")
    .option("--json", "Print JSON")
    .action(async (ref: string, opts: { tags?: string; json?: boolean }) => {
      const rows = await projectSuiteRows(ref, parseTagList(opts.tags));
      if (opts.json) return printJson(rows);
      for (const s of rows) console.log(`${s.id}\t${s.name}\tv${s.currentVersion}\t[${(s.tags ?? []).join(",")}]\t${s.description ?? ""}`);
    });

  project
    .command("scenarios")
    .description("List scenario frames in current suite versions, with tags")
    .argument("<project>", "Project id or name")
    .option("--suite <id>", "Suite id or name")
    .option("--tags <tags>", "Only scenarios carrying every one of these comma-separated tags")
    .option("--json", "Print JSON")
    .action(async (ref: string, opts: { suite?: string; tags?: string; json?: boolean }) => {
      const rows = await projectScenarioRows(ref, { suite: opts.suite, tags: parseTagList(opts.tags) });
      if (opts.json) return printJson(rows);
      for (const s of rows) console.log(`${s.scenarioId}\t${s.suiteName}\t${s.name}\t[${s.tags.join(",")}]`);
    });

  project
    .command("scenario-tag")
    .description("Replace a scenario's tags")
    .argument("<project>", "Project id or name")
    .argument("<scenario>", "Scenario id")
    .argument("[tags...]", "Tags")
    .option("--suite <id>", "Suite id or name that owns the scenario. Defaults to the first suite")
    .action(async (ref: string, scenario: string, tags: string[], opts: { suite?: string }) => {
      const saved = await projectTag(ref, "scenario", { id: scenario, suite: opts.suite, tags: parseTagList(tags) });
      console.log(saved.length ? `Tags: ${saved.join(", ")}` : "Tags cleared.");
    });

  project
    .command("run-tag")
    .description("Replace a stored run's tags")
    .argument("<project>", "Project id or name")
    .argument("<run>", "Run id")
    .argument("[tags...]", "Tags")
    .action(async (ref: string, run: string, tags: string[]) => {
      const saved = await projectTag(ref, "run", { id: run, tags: parseTagList(tags) });
      console.log(saved.length ? `Tags: ${saved.join(", ")}` : "Tags cleared.");
    });
}
