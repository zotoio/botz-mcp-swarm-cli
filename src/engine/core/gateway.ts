import type { Manifest } from "../types/manifest.js";
import type { HopFailure, HopFailureClass, GatewayMetrics } from "../types/run.js";

export type HopSource = "header" | "edge-only";

export interface HopObservation {
  edgeToEdgeMs: number;
  hopMs?: number;
  hopSource: HopSource;
  success: boolean;
  failureClass?: HopFailureClass;
}

/** Documented gateway hop timing header (milliseconds, decimal). */
export const HOP_HEADER = "x-mcp-gateway-hop-ms";

/** Alternate header names gateways may emit. */
export const HOP_HEADER_ALIASES = [
  HOP_HEADER,
  "x-mcp-gateway-hop-ms",
  "X-Mcp-Gateway-Hop-Ms",
] as const;

export function isGatewayMode(manifest: Manifest): boolean {
  return manifest.gateway?.mode === "gateway";
}

export function parseHopMsFromHeaders(
  headers?: Record<string, string>,
): number | undefined {
  if (!headers) return undefined;
  const raw = headers[HOP_HEADER] ?? headers["X-Mcp-Gateway-Hop-Ms"];
  if (!raw) return undefined;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : undefined;
}

export function classifyHopFailure(
  errorMessage?: string,
  statusCode?: number,
): HopFailureClass {
  const msg = (errorMessage ?? "").toLowerCase();
  if (msg.includes("timeout")) return "gateway_timeout";
  if (msg.includes("auth") || msg.includes("401") || msg.includes("403")) {
    return statusCode === 401 || statusCode === 403 ? "gateway_auth" : "gateway_auth";
  }
  if (msg.includes("route") || msg.includes("502") || msg.includes("503")) {
    return "gateway_routing";
  }
  if (msg.includes("unreachable") || msg.includes("econnrefused")) {
    return "upstream_unreachable";
  }
  return "upstream_error";
}

export function buildGatewayMetrics(
  manifest: Manifest,
  observations: HopObservation[],
): GatewayMetrics | undefined {
  if (!isGatewayMode(manifest)) return undefined;

  const edge = observations.map((o) => o.edgeToEdgeMs);
  const hops = observations.filter((o) => o.hopMs !== undefined).map((o) => o.hopMs!);
  const hopFailures: HopFailure[] = observations
    .filter((o) => !o.success && o.failureClass)
    .map((o, i) => ({
      index: i,
      class: o.failureClass!,
      edgeToEdgeMs: o.edgeToEdgeMs,
      hopMs: o.hopMs,
    }));

  const headerCount = observations.filter((o) => o.hopSource === "header").length;
  const hopSource: HopSource | "mixed" =
    headerCount === 0
      ? "edge-only"
      : headerCount === observations.length
        ? "header"
        : "mixed";

  return {
    mode: "gateway",
    gatewayId: manifest.gateway?.gatewayId,
    edgeToEdgeMs: percentiles(edge),
    hopMs: hops.length > 0 ? percentiles(hops) : undefined,
    hopSource,
    hopFailures,
  };
}

export interface GatewayCallResult {
  latencyMs: number;
  success: boolean;
  errorMessage?: string;
  responseHeaders?: Record<string, string>;
}

/** Build a gateway hop observation from a call result and response headers. */
export function observeGatewayHop(result: GatewayCallResult): HopObservation {
  const hopMs = parseHopMsFromHeaders(result.responseHeaders);
  return {
    edgeToEdgeMs: result.latencyMs,
    hopMs,
    hopSource: hopMs !== undefined ? "header" : "edge-only",
    success: result.success,
    failureClass: result.success
      ? undefined
      : classifyHopFailure(result.errorMessage),
  };
}

function percentiles(values: number[]) {
  if (values.length === 0) return { p50: 0, p95: 0, p99: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (p: number) =>
    sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
  return { p50: pick(50), p95: pick(95), p99: pick(99) };
}
