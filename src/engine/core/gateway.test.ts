import { describe, it, expect } from "vitest";
import {
  buildGatewayMetrics,
  classifyHopFailure,
  isGatewayMode,
  parseHopMsFromHeaders,
  observeGatewayHop,
  HOP_HEADER,
} from "@zotoio/botz-mcp-swarm-engine/core/gateway.js";
import type { Manifest } from "@zotoio/botz-mcp-swarm-engine/types/manifest.js";

describe("gateway", () => {
  const manifest: Manifest = {
    name: "gw",
    target: { transport: "stdio", command: "mock-server/run.sh" },
    gateway: { mode: "gateway", gatewayId: "edge-gw" },
    allowlist: ["stdio", "edge-gw"],
    sessionPool: { size: 1, reuse: "cold" },
    quotas: {
      maxConcurrency: 1,
      maxDurationMs: 1000,
      maxCallCount: 10,
      maxPayloadBytes: 1024,
    },
    scenarios: [],
    assertions: { maxErrorRate: 0, requireScenarioOutcomes: true },
  };

  it("detects gateway mode", () => {
    expect(isGatewayMode(manifest)).toBe(true);
  });

  it("builds hop metrics and failure taxonomy", () => {
    const metrics = buildGatewayMetrics(manifest, [
      { edgeToEdgeMs: 100, hopMs: 20, hopSource: "header", success: true },
      {
        edgeToEdgeMs: 200,
        hopMs: 40,
        hopSource: "header",
        success: false,
        failureClass: classifyHopFailure("gateway timeout"),
      },
    ]);
    expect(metrics?.mode).toBe("gateway");
    expect(metrics?.hopFailures).toHaveLength(1);
    expect(metrics?.hopFailures[0].class).toBe("gateway_timeout");
    expect(metrics?.hopSource).toBe("header");
  });

  it("parses hop header contract", () => {
    expect(parseHopMsFromHeaders({ [HOP_HEADER]: "12.5" })).toBe(12.5);
    expect(parseHopMsFromHeaders({ "X-Mcp-Gateway-Hop-Ms": "9" })).toBe(9);
    expect(parseHopMsFromHeaders({})).toBeUndefined();
  });

  it("labels edge-only when hop header absent", () => {
    const obs = observeGatewayHop({
      latencyMs: 50,
      success: true,
      responseHeaders: {},
    });
    expect(obs.hopMs).toBeUndefined();
    expect(obs.hopSource).toBe("edge-only");
  });

  it("uses header hop timing when present", () => {
    const obs = observeGatewayHop({
      latencyMs: 50,
      success: true,
      responseHeaders: { [HOP_HEADER]: "7" },
    });
    expect(obs.hopMs).toBe(7);
    expect(obs.hopSource).toBe("header");
  });

  it("reports mixed hop source", () => {
    const metrics = buildGatewayMetrics(manifest, [
      { edgeToEdgeMs: 100, hopMs: 20, hopSource: "header", success: true },
      { edgeToEdgeMs: 80, hopSource: "edge-only", success: true },
    ]);
    expect(metrics?.hopSource).toBe("mixed");
  });
});
