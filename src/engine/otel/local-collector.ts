import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";
import { defaultLocalOtelEndpoint } from "../service/policy.js";
import { stripSecretAttributes } from "./sanitize.js";

const MAX_SAMPLES = 500;
const MAX_EXPORTS = 200;
const MAX_BODY_BYTES = 1_000_000;
/** Exports that arrive without a run id. A saved run is not stored here. */
const UNSCOPED_RUN = "_";
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/;

export interface LocalOtelSeries {
  name: string;
  unit: string;
  label: string;
  count: number;
  sum: number;
  avg: number;
  /** Attributes on the latest point for this series and label. */
  attributes: Record<string, string>;
}

export interface LocalOtelSnapshot {
  endpoint: string;
  lastExportAt: string | null;
  metricExports: number;
  spanExports: number;
  series: LocalOtelSeries[];
  spans: Array<{ name: string; count: number; attributes: Record<string, string> }>;
}

interface Sample {
  name: string;
  unit: string;
  label: string;
  count: number;
  sum: number;
  runId: string;
  attributes: Record<string, string>;
}

interface SpanHit {
  name: string;
  runId: string;
  attributes: Record<string, string>;
}

const samples: Sample[] = [];
const spanHits: SpanHit[] = [];
const metricExportsByRun = new Map<string, number>();
const spanExportsByRun = new Map<string, number>();
const lastExportByRun = new Map<string, string>();
let metricExports = 0;
let spanExports = 0;
let lastExportAt: string | null = null;
/** Folder of `{ kind, at, body }` files. Unset in tests, so they stay in memory. */
let storeDir: string | null = null;
let disk: Promise<void> = Promise.resolve();
let exportSeq = 0;

/**
 * Env present the first time a target is installed.
 * Captured lazily so `.env` loading can run before the first install.
 * Later policy edits must not overwrite an operator-set endpoint.
 */
let operatorEndpoint: string | null = null;

export function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/** Point export at the policy URL, or the in-process collector, unless the operator set an endpoint. */
export function installOtelExportTarget(port: number, policyEndpoint?: string): string {
  if (operatorEndpoint === null) {
    operatorEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() ?? "";
  }
  if (operatorEndpoint) return operatorEndpoint.replace(/\/$/, "");
  const target = (policyEndpoint?.trim() || defaultLocalOtelEndpoint(port)).replace(/\/$/, "");
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = target;
  return target;
}

export function resetLocalCollector(): void {
  clearMemory();
  storeDir = null;
  disk = Promise.resolve();
}

/** Load a gitignored export folder, then keep each new batch with its run. */
export async function openLocalCollector(dir: string): Promise<void> {
  await flushLocalCollector();
  storeDir = null;
  clearMemory();
  await mkdir(dir, { recursive: true });
  await migrateLegacyExports(dir);
  await replayStore(dir);
  storeDir = dir;
}

/** Drop one run's exports from memory and from the otel folder. */
export async function forgetRunExports(runId: string): Promise<void> {
  if (!RUN_ID_PATTERN.test(runId)) return;
  dropRunMemory(runId);
  const dir = storeDir;
  if (!dir) return;
  const folder = runFolder(dir, runId);
  disk = disk.then(() => rm(folder, { recursive: true, force: true })).catch((error: unknown) => {
    console.error("otel export folder was not removed", error instanceof Error ? error.message : error);
  });
  await disk;
}

/**
 * Remove export folders that are not a saved or live run and are older than the retention window.
 * Folders for saved runs stay until that execution is deleted.
 */
export async function pruneOrphanExports(
  keepRunIds: ReadonlySet<string>,
  olderThanMs: number,
  now = Date.now(),
): Promise<string[]> {
  const dir = storeDir;
  if (!dir || !Number.isFinite(olderThanMs) || olderThanMs <= 0) return [];
  await flushLocalCollector();
  const root = join(dir, "runs");
  let names: string[] = [];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    if (name === UNSCOPED_RUN || keepRunIds.has(name) || !RUN_ID_PATTERN.test(name)) continue;
    const folder = join(root, name);
    const info = await stat(folder).catch(() => null);
    if (!info || now - info.mtimeMs < olderThanMs) continue;
    await rm(folder, { recursive: true, force: true });
    dropRunMemory(name);
    removed.push(name);
  }
  return removed;
}

export function flushLocalCollector(): Promise<void> {
  return disk;
}

function clearMemory(): void {
  samples.length = 0;
  spanHits.length = 0;
  metricExportsByRun.clear();
  spanExportsByRun.clear();
  lastExportByRun.clear();
  metricExports = 0;
  spanExports = 0;
  lastExportAt = null;
}

/**
 * Collector view.
 * Omit `runId` for every export. Pass a run id to keep that execution. Pass null for an empty view.
 */
export function localOtelSnapshot(endpoint: string, runId?: string | null): LocalOtelSnapshot {
  const scoped = runId !== undefined;
  const latest = new Map<string, Sample>();
  for (const sample of samples) {
    if (scoped && sample.runId !== runId) continue;
    latest.set(`${sample.name}\0${sample.label}`, sample);
  }
  const series = [...latest.values()]
    .map((sample) => ({
      name: sample.name,
      unit: sample.unit,
      label: sample.label,
      count: sample.count,
      sum: sample.sum,
      avg: sample.count > 0 ? sample.sum / sample.count : sample.sum,
      attributes: sample.attributes,
    }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const spanCounts = new Map<string, { count: number; attributes: Record<string, string> }>();
  for (const hit of spanHits) {
    if (scoped && hit.runId !== runId) continue;
    const current = spanCounts.get(hit.name);
    spanCounts.set(hit.name, {
      count: (current?.count ?? 0) + 1,
      attributes: Object.keys(hit.attributes).length ? hit.attributes : (current?.attributes ?? {}),
    });
  }
  const spans = [...spanCounts.entries()]
    .map(([name, hit]) => ({ name, count: hit.count, attributes: hit.attributes }))
    .sort((a, b) => b.count - a.count);
  return {
    endpoint,
    lastExportAt: scoped ? (runId ? lastExportByRun.get(runId) ?? null : null) : lastExportAt,
    metricExports: scoped ? (runId ? metricExportsByRun.get(runId) ?? 0 : 0) : metricExports,
    spanExports: scoped ? (runId ? spanExportsByRun.get(runId) ?? 0 : 0) : spanExports,
    series,
    spans,
  };
}

export async function readLimitedBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) throw new Error("otlp_body_too_large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const SENSITIVE_ATTR_PATTERN = /authorization|token|secret|password|api[_-]?key|bearer|credential/i;
const BEARER_STR = /^bearer\s+/i;

function scrubOtlpAttributesList(attrs: DataPoint["attributes"]): DataPoint["attributes"] {
  if (!Array.isArray(attrs)) return attrs;
  return attrs.filter((attr) => {
    const key = attr?.key ?? "";
    if (SENSITIVE_ATTR_PATTERN.test(key)) return false;
    const val = attrValue(attr?.value);
    if (BEARER_STR.test(val)) return false;
    return true;
  });
}

function resolveEffectiveRunId(
  pointOrSpanAttrs: Record<string, string>,
  resourceRunId: string,
  defaultRunId?: string,
): string {
  const fromAttr = pointOrSpanAttrs["run.id"] || pointOrSpanAttrs["swarm.run_id"] || "";
  if (fromAttr && RUN_ID_PATTERN.test(fromAttr)) return fromAttr;
  if (resourceRunId && RUN_ID_PATTERN.test(resourceRunId)) return resourceRunId;
  const trimmedDefault = defaultRunId?.trim() ?? "";
  if (trimmedDefault && RUN_ID_PATTERN.test(trimmedDefault)) return trimmedDefault;
  return "";
}

export function ingestOtlpMetrics(body: string, defaultRunId?: string): number {
  return ingestMetrics(body, { persist: true, defaultRunId });
}

export function ingestOtlpTraces(body: string, defaultRunId?: string): number {
  return ingestTraces(body, { persist: true, defaultRunId });
}

function ingestMetrics(body: string, options: { persist: boolean; at?: string; defaultRunId?: string }): number {
  const parsed = JSON.parse(body) as { resourceMetrics?: ResourceMetrics[] };
  let points = 0;
  const runs = new Set<string>();
  for (const resource of parsed.resourceMetrics ?? []) {
    if (resource.resource?.attributes) {
      resource.resource.attributes = scrubOtlpAttributesList(resource.resource.attributes);
    }
    const resRunId = runIdOf(resource.resource);
    if (resRunId) runs.add(resRunId);
    for (const scope of resource.scopeMetrics ?? []) {
      for (const metric of scope.metrics ?? []) {
        points += recordMetric(metric, resRunId, options.defaultRunId, runs);
      }
    }
  }
  if (points > 0) {
    const now = options.at ?? new Date().toISOString();
    metricExports += 1;
    lastExportAt = now;
    noteExport(metricExportsByRun, runs, now);
    if (options.persist) remember("metrics", JSON.stringify(parsed), now, runs);
  }
  return points;
}

function ingestTraces(body: string, options: { persist: boolean; at?: string; defaultRunId?: string }): number {
  const parsed = JSON.parse(body) as { resourceSpans?: ResourceSpans[] };
  let count = 0;
  const runs = new Set<string>();
  for (const resource of parsed.resourceSpans ?? []) {
    if (resource.resource?.attributes) {
      resource.resource.attributes = scrubOtlpAttributesList(resource.resource.attributes);
    }
    const resRunId = runIdOf(resource.resource);
    if (resRunId) runs.add(resRunId);
    for (const scope of resource.scopeSpans ?? []) {
      for (const span of scope.spans ?? []) {
        if (span.attributes) {
          span.attributes = scrubOtlpAttributesList(span.attributes);
        }
        const name = span.name?.trim() || "span";
        const rawAttrs = attributeMap(span.attributes);
        const effRunId = resolveEffectiveRunId(rawAttrs, resRunId, options.defaultRunId);
        if (effRunId) runs.add(effRunId);
        const cleanAttrs = Object.fromEntries(
          Object.entries(stripSecretAttributes(rawAttrs)).map(([k, v]) => [k, String(v)]),
        );
        spanHits.push({ name, runId: effRunId, attributes: cleanAttrs });
        count += 1;
      }
    }
  }
  if (count > 0) {
    const now = options.at ?? new Date().toISOString();
    spanExports += 1;
    lastExportAt = now;
    noteExport(spanExportsByRun, runs, now);
    if (options.persist) remember("traces", JSON.stringify(parsed), now, runs);
  }
  return count;
}

function remember(kind: "metrics" | "traces", body: string, at: string, runs: Set<string>): void {
  const dir = storeDir;
  if (!dir) return;
  exportSeq += 1;
  const name = `${at.replace(/[:.]/g, "-")}-${String(exportSeq).padStart(4, "0")}-${kind}.json`;
  const payload = JSON.stringify({ kind, at, body });
  const ids = [...runs].filter((id) => RUN_ID_PATTERN.test(id));
  const targets = ids.length > 0 ? ids : [UNSCOPED_RUN];
  disk = disk.then(() => writeExport(dir, name, payload, targets)).catch((error: unknown) => {
    console.error("otel export was not saved", error instanceof Error ? error.message : error);
  });
}

/** A saved run keeps every batch. Only exports with no run id are capped. */
async function writeExport(dir: string, name: string, payload: string, runIds: string[]): Promise<void> {
  for (const runId of runIds) {
    const folder = runFolder(dir, runId);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, name), payload);
    if (runId === UNSCOPED_RUN) await capFolder(folder);
  }
}

async function capFolder(folder: string): Promise<void> {
  const names = (await readdir(folder)).filter((name) => name.endsWith(".json")).sort();
  const extra = names.slice(0, Math.max(0, names.length - MAX_EXPORTS));
  await Promise.all(extra.map((name) => rm(join(folder, name), { force: true })));
}

function runFolder(dir: string, runId: string): string {
  return join(dir, "runs", RUN_ID_PATTERN.test(runId) ? runId : UNSCOPED_RUN);
}

async function migrateLegacyExports(dir: string): Promise<void> {
  const names = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  for (const name of names) {
    const file = join(dir, name);
    let stored: { kind?: string; at?: string; body?: string };
    try {
      stored = JSON.parse(await readFile(file, "utf8")) as { kind?: string; at?: string; body?: string };
    } catch {
      continue;
    }
    if ((stored.kind !== "metrics" && stored.kind !== "traces") || typeof stored.body !== "string") continue;
    const ids = runIdsInBody(stored.kind, stored.body);
    const targets = ids.length > 0 ? ids : [UNSCOPED_RUN];
    const payload = JSON.stringify({ kind: stored.kind, at: stored.at, body: stored.body });
    for (const runId of targets) {
      const folder = runFolder(dir, runId);
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, name), payload);
    }
    await rm(file, { force: true });
  }
}

async function replayStore(dir: string): Promise<void> {
  const root = join(dir, "runs");
  let folders: string[] = [];
  try {
    folders = (await readdir(root)).sort();
  } catch {
    return;
  }
  const seen = new Set<string>();
  for (const folder of folders) {
    let names: string[] = [];
    try {
      names = (await readdir(join(root, folder))).filter((name) => name.endsWith(".json")).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      let stored: { kind?: string; at?: string; body?: string };
      try {
        stored = JSON.parse(await readFile(join(root, folder, name), "utf8")) as {
          kind?: string;
          at?: string;
          body?: string;
        };
      } catch {
        continue;
      }
      if (typeof stored.body !== "string") continue;
      const key = `${stored.kind}\0${stored.body}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const at = typeof stored.at === "string" ? stored.at : undefined;
      if (stored.kind === "metrics") ingestMetrics(stored.body, { persist: false, at });
      else if (stored.kind === "traces") ingestTraces(stored.body, { persist: false, at });
    }
  }
}

function runIdsInBody(kind: "metrics" | "traces", body: string): string[] {
  try {
    const parsed = JSON.parse(body) as {
      resourceMetrics?: ResourceMetrics[];
      resourceSpans?: ResourceSpans[];
    };
    const resources = kind === "metrics"
      ? (parsed.resourceMetrics ?? []).map((resource) => resource.resource)
      : (parsed.resourceSpans ?? []).map((resource) => resource.resource);
    return [...new Set(resources.map((resource) => runIdOf(resource)).filter((id) => RUN_ID_PATTERN.test(id)))];
  } catch {
    return [];
  }
}

function dropRunMemory(runId: string): void {
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    if (samples[index]?.runId === runId) samples.splice(index, 1);
  }
  for (let index = spanHits.length - 1; index >= 0; index -= 1) {
    if (spanHits[index]?.runId === runId) spanHits.splice(index, 1);
  }
  metricExportsByRun.delete(runId);
  spanExportsByRun.delete(runId);
  lastExportByRun.delete(runId);
}

function noteExport(counts: Map<string, number>, runs: Set<string>, now: string): void {
  const ids = runs.size > 0 ? runs : new Set([""]);
  for (const id of ids) {
    if (!id) continue;
    counts.set(id, (counts.get(id) ?? 0) + 1);
    lastExportByRun.set(id, now);
  }
}

interface ResourceMetrics {
  resource?: { attributes?: DataPoint["attributes"] };
  scopeMetrics?: Array<{ metrics?: Metric[] }>;
}

interface Metric {
  name?: string;
  unit?: string;
  histogram?: { dataPoints?: DataPoint[] };
  sum?: { dataPoints?: DataPoint[] };
  gauge?: { dataPoints?: DataPoint[] };
}

interface DataPoint {
  attributes?: Array<{ key?: string; value?: Record<string, unknown> }>;
  count?: number | string;
  sum?: number | string;
  asDouble?: number | string;
  asInt?: number | string;
  value?: number | string;
}

interface ResourceSpans {
  resource?: { attributes?: DataPoint["attributes"] };
  scopeSpans?: Array<{ spans?: Array<{ name?: string; attributes?: DataPoint["attributes"] }> }>;
}

function runIdOf(resource: { attributes?: DataPoint["attributes"] } | undefined): string {
  for (const attribute of resource?.attributes ?? []) {
    if (attribute.key === "run.id" || attribute.key === "swarm.run_id") return attrValue(attribute.value);
  }
  return "";
}

function recordMetric(
  metric: Metric,
  resourceRunId: string,
  defaultRunId?: string,
  runsOut?: Set<string>,
): number {
  const name = metric.name?.trim();
  if (!name) return 0;
  const points = metric.histogram?.dataPoints ?? metric.sum?.dataPoints ?? metric.gauge?.dataPoints ?? [];
  let recorded = 0;
  for (const point of points) {
    if (point.attributes) {
      point.attributes = scrubOtlpAttributesList(point.attributes);
    }
    const count = metric.gauge ? 1 : num(point.count);
    const sum = metric.gauge
      ? num(point.asDouble ?? point.asInt ?? point.value)
      : num(point.sum ?? point.asDouble ?? point.asInt);
    const rawAttrs = attributeMap(point.attributes);
    const effRunId = resolveEffectiveRunId(rawAttrs, resourceRunId, defaultRunId);
    if (effRunId && runsOut) runsOut.add(effRunId);
    const attributes = Object.fromEntries(
      Object.entries(stripSecretAttributes(rawAttrs)).map(([k, v]) => [k, String(v)]),
    );
    pushSample({
      name,
      unit: metric.unit ?? "",
      label: labelFor(attributes),
      count: Number.isFinite(count) ? count : 0,
      sum: Number.isFinite(sum) ? sum : 0,
      runId: effRunId,
      attributes,
    });
    recorded += 1;
  }
  return recorded;
}

function pushSample(sample: Sample): void {
  samples.push(sample);
  if (sample.runId) return;
  let unscoped = 0;
  for (const item of samples) {
    if (!item.runId) unscoped += 1;
  }
  if (unscoped <= MAX_SAMPLES) return;
  const index = samples.findIndex((item) => !item.runId);
  if (index >= 0) samples.splice(index, 1);
}

function attributeMap(attributes: DataPoint["attributes"]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const attribute of attributes ?? []) {
    if (!attribute.key) continue;
    map[attribute.key] = attrValue(attribute.value);
  }
  return map;
}

function labelFor(attributes: Record<string, string>): string {
  return attributes.tool || attributes.role || attributes.method || attributes.scenario || attributes.error_class || "all";
}

function attrValue(value: Record<string, unknown> | undefined): string {
  if (!value) return "";
  for (const key of ["stringValue", "intValue", "doubleValue", "boolValue"]) {
    if (value[key] != null) return String(value[key]);
  }
  return "";
}

function num(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) return Number(value);
  return 0;
}
