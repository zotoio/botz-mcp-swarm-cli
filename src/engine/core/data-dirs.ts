import { join } from "node:path";

/** Service and studio state lives beside CLI suites and runs, under `.botz/mcp-swarm` in the working directory. */
export const SWARM_HOME = join(".botz", "mcp-swarm");

/** Policy, sessions, projects, schedules, audit log, and stored runs (formerly `.swarm-data`). */
export function swarmDataDir(cwd = process.cwd()): string {
  return join(cwd, SWARM_HOME, "data");
}

/** Local OTLP collector store (formerly `.otel`). */
export function otelStoreDir(cwd = process.cwd()): string {
  return join(cwd, SWARM_HOME, "otel");
}
