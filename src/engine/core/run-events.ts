import type { RunProgressEvent } from "../types/run.js";

const MAX_BUFFER = 2000;

const buffers = new Map<string, RunProgressEvent[]>();
const listeners = new Map<string, Set<(event: RunProgressEvent) => void>>();
const activeBySuite = new Map<string, string>();
const activeControllers = new Map<string, AbortController>();

import type { LoadProfile } from "./suite-model.js";

export interface ActiveSuiteRun {
  runId: string;
  suiteId: string;
  projectId: string;
  projectName: string;
  suiteName: string;
  startedAt: string;
  previousRunDurationMs?: number | null;
  previousRunLoad?: Partial<LoadProfile> | null;
  estimatedDurationMs?: number;
  load?: Partial<LoadProfile>;
  totalSteps?: number;
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

export function registerSuiteRunController(runId: string, controller: AbortController): void {
  activeControllers.set(runId, controller);
}

/** One in-flight run per suite. Returns false when that suite is already running. */
export function tryBeginSuiteRun(
  suiteId: string,
  runId: string,
  meta?: {
    projectId: string;
    projectName: string;
    suiteName: string;
    startedAt?: string;
    previousRunDurationMs?: number | null;
    previousRunLoad?: Partial<LoadProfile> | null;
    estimatedDurationMs?: number;
    load?: Partial<LoadProfile>;
    totalSteps?: number;
    controller?: AbortController;
  },
): boolean {
  if (activeBySuite.has(suiteId)) return false;
  activeBySuite.set(suiteId, runId);
  if (meta?.controller) activeControllers.set(runId, meta.controller);
  activeMeta.set(suiteId, {
    runId,
    suiteId,
    projectId: meta?.projectId ?? "",
    projectName: meta?.projectName ?? "",
    suiteName: meta?.suiteName ?? "",
    startedAt: meta?.startedAt ?? new Date().toISOString(),
    ...(meta?.previousRunDurationMs !== undefined ? { previousRunDurationMs: meta.previousRunDurationMs } : {}),
    ...(meta?.previousRunLoad !== undefined ? { previousRunLoad: meta.previousRunLoad } : {}),
    ...(meta?.estimatedDurationMs !== undefined ? { estimatedDurationMs: meta.estimatedDurationMs } : {}),
    ...(meta?.load !== undefined ? { load: meta.load } : {}),
    ...(meta?.totalSteps !== undefined ? { totalSteps: meta.totalSteps } : {}),
  });
  return true;
}

/** Recently finished runs (newest last), for late-ingest checks. Bounded; older runs fall back to saved reports. */
const finishedRuns = new Map<string, { projectId: string; finishedAt: number }>();
const FINISHED_RUNS_MAX = 2000;

export function recentlyFinishedRun(runId: string): { projectId: string; finishedAt: number } | undefined {
  return finishedRuns.get(runId);
}

export function finishSuiteRun(suiteId: string, runId: string): void {
  const meta = activeMeta.get(suiteId);
  if (meta?.runId === runId) {
    finishedRuns.delete(runId);
    finishedRuns.set(runId, { projectId: meta.projectId, finishedAt: Date.now() });
    while (finishedRuns.size > FINISHED_RUNS_MAX) finishedRuns.delete(finishedRuns.keys().next().value as string);
  }
  if (activeBySuite.get(suiteId) === runId) {
    activeBySuite.delete(suiteId);
    activeMeta.delete(suiteId);
  }
  activeControllers.delete(runId);
}

export function abortSuiteRun(runId: string, projectId?: string): boolean {
  const active = listActiveRuns().find(
    (run) => run.runId === runId && (!projectId || run.projectId === projectId),
  );
  if (!active) return false;
  const controller = activeControllers.get(runId);
  finishSuiteRun(active.suiteId, active.runId);
  controller?.abort();
  return true;
}

export function stopActiveSuiteRun(projectId: string, runId: string): { ok: boolean; suiteId?: string } {
  const active = listActiveRuns().find(
    (run) => run.runId === runId && (!projectId || run.projectId === projectId),
  );
  if (!active) return { ok: false };
  abortSuiteRun(runId, projectId);
  return { ok: true, suiteId: active.suiteId };
}

export function activeRunForSuite(suiteId: string): string | undefined {
  return activeBySuite.get(suiteId);
}

export function listActiveRuns(): ActiveSuiteRun[] {
  return [...activeMeta.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** t559: runs whose steps ended but whose background tool evals / final save are still in flight. */
export interface FinalizingRun { runId: string; projectId: string; suiteId: string; pending: string; since: string }
const finalizing = new Map<string, FinalizingRun>();

export function beginRunFinalizing(run: FinalizingRun): void {
  finalizing.set(run.runId, run);
}

export function endRunFinalizing(runId: string): void {
  finalizing.delete(runId);
}

export function listFinalizingRuns(): FinalizingRun[] {
  return [...finalizing.values()];
}
