export { parseManifest, type Manifest } from "./types/manifest.js";
export { runManifest, type ToolResultValidator } from "./core/runner.js";
export { writeReports, formatMarkdownReport } from "./core/report.js";
export { compareRuns, loadRunReport, formatCompareMarkdown } from "./core/compare.js";
export {
  detectSilentGreen,
  computeVerdict,
  MetricsCollector,
} from "./core/metrics.js";
export { redactValue, redactString, REDACTED } from "./core/redaction.js";
export {
  assertTargetAllowlisted,
  isTargetAllowlisted,
} from "./core/allowlist.js";
export { recordSession, replayRecording, loadRecording } from "./core/record-replay.js";
export type {
  RunReport,
  CompareReport,
  ToolSeries,
  ProcessSample,
  ProcessSummary,
} from "./types/run.js";
export { ProcessGaugeCollector } from "./core/process-gauges.js";
export { runDiscovery, approveDiscoveryDraft } from "./core/discovery.js";
export { findRepoRoot } from "./core/repo-root.js";
export { resolveStdioTarget } from "./core/target-resolve.js";
export { formatRunLog, tailRunLog, type StepCall } from "./core/run-log.js";
export * from "./ports/host.js";
export * from "./worker-protocol/frames.js";
