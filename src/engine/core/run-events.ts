import type { RunProgressEvent } from "../types/run.js";

const MAX_BUFFER = 2000;

const buffers = new Map<string, RunProgressEvent[]>();
const listeners = new Map<string, Set<(event: RunProgressEvent) => void>>();
const activeBySuite = new Map<string, string>();

export interface ActiveSuiteRun {
  runId: string;
  suiteId: string;
  projectId: string;
  projectName: string;
  suiteName: string;
  startedAt: string;
}

const activeMeta = new Map<string, ActiveSuiteRun>();

export function publishRunEvent(event: RunProgressEvent): void {
  const buffer = buffers.get(event.runId) ?? [];
  buffer.push(event);
  if (buffer.length > MAX_BUFFER) buffer.shift();
  buffers.set(event.runId, buffer);
  for (const listener of listeners.get(event.runId) ?? []) listener(event);
}

export function bufferedRunEvents(runId: string): RunProgressEvent[] {
  return [...(buffers.get(runId) ?? [])];
}

export function subscribeRunEvents(
  runId: string,
  listener: (event: RunProgressEvent) => void,
): () => void {
  const set = listeners.get(runId) ?? new Set();
  set.add(listener);
  listeners.set(runId, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(runId);
  };
}

/** One in-flight run per suite. Returns false when that suite is already running. */
export function tryBeginSuiteRun(
  suiteId: string,
  runId: string,
  meta?: { projectId: string; projectName: string; suiteName: string; startedAt?: string },
): boolean {
  if (activeBySuite.has(suiteId)) return false;
  activeBySuite.set(suiteId, runId);
  activeMeta.set(suiteId, {
    runId,
    suiteId,
    projectId: meta?.projectId ?? "",
    projectName: meta?.projectName ?? "",
    suiteName: meta?.suiteName ?? "",
    startedAt: meta?.startedAt ?? new Date().toISOString(),
  });
  return true;
}

export function finishSuiteRun(suiteId: string, runId: string): void {
  if (activeBySuite.get(suiteId) === runId) {
    activeBySuite.delete(suiteId);
    activeMeta.delete(suiteId);
  }
}

export function activeRunForSuite(suiteId: string): string | undefined {
  return activeBySuite.get(suiteId);
}

export function listActiveRuns(): ActiveSuiteRun[] {
  return [...activeMeta.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
