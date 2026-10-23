/**
 * `botz-mcp-swarm suite analyse`: ask the configured model to read a failed run report and propose
 * fixes to the suite. Proposals are written next to the report; `--apply` writes a reviewed suite
 * to suite.proposed.json (or replaces suite.json with --in-place, keeping suite.json.bak).
 */
import { readdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { join } from "node:path";
import type { Command } from "commander";
import {
  analyseRun,
  analysisAvailability,
  validateProposal,
  type FixProposal,
  type InferFn,
  type RunAnalysis,
  type SuiteDoc,
} from "../engine/core/run-analysis.js";
import { compileSuite } from "../engine/core/suite-model.js";
import type { RunReport } from "../engine/types/run.js";
import { displayPath, resolveBotzHome, resolveSuiteArg } from "./botz-home.js";
import { loadSuiteFile, parseSuiteFile, type SuiteFile } from "./suite-file.js";

/** Newest report in `runsDir` for this suite (by manifest name), else the newest report. */
export async function latestReportFor(runsDir: string, suiteName: string): Promise<string | null> {
  let names: string[] = [];
  try {
    names = (await readdir(runsDir)).filter((n) => /^botz-run-.*\.json$/.test(n) && !n.endsWith(".analysis.json")).sort().reverse();
  } catch {
    return null;
  }
  for (const name of names) {
    try {
      const report = JSON.parse(await readFile(join(runsDir, name), "utf8")) as Partial<RunReport>;
      if (report.manifestName === suiteName) return join(runsDir, name);
    } catch { /* skip unreadable */ }
  }
  return names[0] ? join(runsDir, names[0]) : null;
}

function suiteDoc(suite: SuiteFile): SuiteDoc {
  return { nodes: suite.nodes, load: suite.load };
}

function compileFor(suite: SuiteFile) {
  return (doc: SuiteDoc) => {
    compileSuite({ name: suite.name, description: `Suite ${suite.name}`, target: suite.target, allowlist: [], nodes: doc.nodes, load: doc.load });
  };
}

export async function analyseSuiteReport(input: {
  suite: SuiteFile;
  report: RunReport;
  infer?: InferFn;
  env?: NodeJS.ProcessEnv;
}): Promise<RunAnalysis> {
  const { suite, report } = input;
  return analyseRun({
    report,
    suite: suiteDoc(suite),
    catalog: suite.surface.tools,
    target: suite.target,
    validate: { catalog: suite.surface.tools, canRunDestructive: false, compile: compileFor(suite) },
    infer: input.infer,
    env: input.env,
  });
}

/** Apply accepted proposals in order. Throws with the first proposal that does not validate. */
export function applyProposals(suite: SuiteFile, analysis: RunAnalysis, ids: string[], opts: { allowDestructive?: boolean } = {}): SuiteFile {
  const wanted = ids.includes("all")
    ? analysis.proposals.filter((p) => p.category === "suite_bug" && p.status === "proposed")
    : ids.map((id) => {
      const p = analysis.proposals.find((item) => item.id === id);
      if (!p) throw new Error(`unknown proposal ${id}`);
      return p;
    });
  if (wanted.length === 0) throw new Error("no applicable proposals");
  let doc = suiteDoc(suite);
  for (const p of wanted) {
    if (p.category !== "suite_bug") throw new Error(`${p.id} is a ${p.category} finding and is report only`);
    if (p.status !== "proposed") throw new Error(`${p.id} is ${p.status}${p.reason ? `: ${p.reason}` : ""}`);
    const result = validateProposal(doc, p, { catalog: suite.surface.tools, canRunDestructive: opts.allowDestructive === true, compile: compileFor(suite) });
    if (!result.ok) throw new Error(`${p.id} does not apply: ${result.reason}`);
    doc = result.doc;
  }
  return parseSuiteFile({ ...suite, nodes: doc.nodes, load: doc.load });
}

const LABEL: Record<FixProposal["category"], string> = {
  suite_bug: "suite fix",
  server_bug: "server bug (report only)",
  environment: "environment (report only)",
};

export function formatAnalysis(analysis: RunAnalysis): string {
  const lines = [`Analysis ${analysis.id} of run ${analysis.runId} (${analysis.model})`];
  if (analysis.usage) lines.push(`Tokens: ${analysis.usage.inputTokens ?? "?"} in / ${analysis.usage.outputTokens ?? "?"} out`);
  if (analysis.summary) lines.push("", analysis.summary);
  if (analysis.proposals.length === 0) lines.push("", "No fixes proposed.");
  for (const p of analysis.proposals) {
    lines.push("", `[${p.id}] ${p.title}`, `  ${LABEL[p.category]} · ${Math.round(p.confidence * 100)}% · ${p.status}${p.reason ? ` (${p.reason})` : ""}`);
    if (p.rationale) lines.push(`  ${p.rationale}`);
    if (p.report) lines.push(`  Report: ${p.report}`);
    for (const op of p.patch ?? []) lines.push(`  ${op.op} ${op.path}${"value" in op ? ` = ${JSON.stringify(op.value)}` : ""}`);
  }
  const open = analysis.proposals.filter((p) => p.category === "suite_bug" && p.status === "proposed");
  if (open.length) lines.push("", `Apply with: --apply ${open.map((p) => p.id).join(",")} (or --apply all)`);
  return lines.join("\n");
}

function parseIds(raw: string): string[] {
  const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (!ids.length) throw new Error("Give at least one proposal id");
  return ids;
}

/** Record a review decision. Unknown ids and already-decided proposals are errors, so nothing is silently skipped. */
export function markProposals(analysis: RunAnalysis, ids: string[], status: "accepted" | "rejected"): void {
  for (const id of ids) {
    const p = analysis.proposals.find((x) => x.id === id);
    if (!p) throw new Error(`Unknown proposal id ${id}`);
    if (p.status !== "proposed") throw new Error(`${id} is already ${p.status}`);
    p.status = status;
  }
}

interface AnalyseOptions {
  report?: string;
  from?: string;
  out?: string;
  apply?: string;
  reject?: string;
  inPlace?: boolean;
  allowDestructive?: boolean;
  format?: "text" | "json";
}

export function registerAnalyseCommand(parent: Command): void {
  parent
    .command("analyse")
    .alias("analyze")
    .description("Ask the configured model to explain a failed run and propose suite fixes. Nothing changes unless you --apply")
    .argument("<suite>", "Suite name or directory")
    .option("--report <path>", "Run report JSON. Defaults to the newest report for this suite in runsDir")
    .option("--from <path>", "Reuse a saved analysis instead of calling the model")
    .option("--out <path>", "Where to write the analysis. Defaults to <report>.analysis.json")
    .option("--apply <ids>", "Comma-separated proposal ids, or 'all' for every open suite fix")
    .option("--reject <ids>", "With --from, mark these comma-separated proposal ids rejected in the saved analysis")
    .option("--in-place", "With --apply, replace suite.json (the old one is kept as suite.json.bak)")
    .option("--allow-destructive", "With --apply, allow fixes that enable write-like or destructive tools")
    .option("--format <format>", "text or json", "text")
    .action(async (suiteArg: string, opts: AnalyseOptions) => {
      const botz = resolveBotzHome();
      const dir = resolveSuiteArg(suiteArg, botz);
      const suite = await loadSuiteFile(dir);
      let analysis: RunAnalysis;
      if (opts.from) {
        analysis = JSON.parse(await readFile(opts.from, "utf8")) as RunAnalysis;
      } else {
        const availability = analysisAvailability();
        if (!availability.enabled) {
          throw new Error(availability.reason === "disabled"
            ? "Analysis is off (SWARM_ANALYSE=off)"
            : "No inference key is configured. Set SWARM_LLM_PROVIDER and its API key, then try again");
        }
        const reportPath = opts.report ?? await latestReportFor(botz.runsDir, suite.name);
        if (!reportPath) throw new Error("No run report found. Run the suite first or pass --report");
        const report = JSON.parse(await readFile(reportPath, "utf8")) as RunReport;
        analysis = await analyseSuiteReport({ suite, report });
        const out = opts.out ?? reportPath.replace(/\.json$/, "") + ".analysis.json";
        await writeFile(out, JSON.stringify(analysis, null, 2), "utf8");
        if (opts.format !== "json") console.error(`Analysis written: ${displayPath(out, botz, out)}`);
      }
      if (opts.format === "json") console.log(JSON.stringify(analysis, null, 2));
      else console.log(formatAnalysis(analysis));
      if (opts.reject) {
        if (!opts.from) throw new Error("--reject needs --from <analysis.json> so the decision is recorded");
        const ids = parseIds(opts.reject);
        markProposals(analysis, ids, "rejected");
        await writeFile(opts.from, JSON.stringify(analysis, null, 2), "utf8");
        console.error(`Rejected: ${ids.join(", ")}`);
      }
      if (!opts.apply) return;
      const applyIds = parseIds(opts.apply);
      const next = applyProposals(suite, analysis, applyIds, { allowDestructive: opts.allowDestructive });
      const target = opts.inPlace ? join(dir, "suite.json") : join(dir, "suite.proposed.json");
      if (opts.inPlace) await copyFile(join(dir, "suite.json"), join(dir, "suite.json.bak"));
      await writeFile(target, JSON.stringify(next, null, 2), "utf8");
      if (opts.from) {
        const ids = applyIds.includes("all") ? analysis.proposals.filter((p) => p.category === "suite_bug" && p.status === "proposed").map((p) => p.id) : applyIds;
        markProposals(analysis, ids, "accepted");
        await writeFile(opts.from, JSON.stringify(analysis, null, 2), "utf8");
      }
      console.error(`${opts.inPlace ? "Updated" : "Proposed suite written"}: ${displayPath(target, botz, target)}`);
    });
}
