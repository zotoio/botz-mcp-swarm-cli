import type { RunReport } from "../engine/types/run.js";

export type OutputFormat = "text" | "json" | "junit";
const xml = (value: string) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** Include a verdict case so aggregate SLO and inference failures cannot appear green in CI. */
export function formatJUnit(report: RunReport): string {
  const cases = [
    ...report.scenarioOutcomes.map((item) => ({ name: item.scenario, failed: item.outcome !== "pass", message: item.message ?? item.outcome })),
    ...((report.nodeOutcomes ?? []).map((item) => ({ name: item.label, failed: item.errorCount > 0, message: item.errorMessage ?? `${item.errorCount} failed calls` }))),
    ...((report.toolEvals ?? []).map((item) => ({ name: `eval: ${item.id}`, failed: !item.pass, message: item.reason ?? "inference assertion failed" }))),
    { name: "run verdict", failed: report.verdict === "fail", message: report.failReasons.join("\n") },
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites><testsuite name="${xml(report.manifestName)}" tests="${cases.length}" failures="${cases.filter((item) => item.failed).length}" time="${report.durationMs / 1000}">\n${cases.map((item) => `  <testcase name="${xml(item.name)}">${item.failed ? `<failure message="${xml(item.message)}"/>` : ""}</testcase>`).join("\n")}\n</testsuite></testsuites>`;
}

export function printRunResult(report: RunReport, paths: { jsonPath: string; markdownPath: string }, format: OutputFormat): void {
  if (format === "json") console.log(JSON.stringify(report));
  else if (format === "junit") console.log(formatJUnit(report));
  else {
    console.log(`Verdict: ${report.verdict.toUpperCase()}`);
    for (const reason of report.failReasons) console.log(`  - ${reason}`);
    if (report.soak) console.log(`Soak iterations: ${report.soak.iterations}`);
    if (report.otelStatus && report.otelStatus !== "disabled") console.log(`OTLP export: ${report.otelStatus}`);
    console.log(`JSON: ${paths.jsonPath}\nMarkdown: ${paths.markdownPath}`);
  }
  if (report.verdict === "fail" && !process.exitCode) process.exitCode = 1;
}
