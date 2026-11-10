import { describe, expect, it } from "vitest";
import { clientTraceparent, parseW3CTraceparent } from "./http-fetch.js";
import { buildTraceIndex } from "@zotoio/botz-mcp-swarm-core/otel/trace-query.js";

const T = "4bf92f3577b34da6a3ce929d0e0e4736";
const SENT = `00-${T}-00f067aa0ba902b7-01`;
const ECHO = `00-${T}-b7ad6b7169203331-01`; // server's own span id echoed on the response

describe("client span identity uses the SENT traceparent", () => {
  it("prefers what swarm sent over the server's echoed traceparent", () => {
    expect(clientTraceparent({ traceparent: SENT }, { traceparent: ECHO })).toBe(SENT);
    expect(clientTraceparent({}, { traceparent: ECHO })).toBe(ECHO);
    expect(clientTraceparent(undefined, undefined)).toBeUndefined();
    expect(parseW3CTraceparent(clientTraceparent({ traceparent: SENT }, { traceparent: ECHO }))?.spanId).toBe("00f067aa0ba902b7");
  });
});

const kv = (o: Record<string, string>) => Object.entries(o).map(([key, v]) => ({ key, value: { stringValue: v } }));
const ns = (ms: number) => String(BigInt(Math.round(ms * 1000)) * 1000n);
function client(spanId: string) {
  return JSON.stringify({ resourceSpans: [{ resource: { attributes: kv({ "service.name": "botz-mcp-swarm", "run.id": "run1" }) }, scopeSpans: [{ spans: [{
    name: "mcp.tools/call", traceId: T, spanId: "1".repeat(16), startTimeUnixNano: ns(0), endTimeUnixNano: ns(100),
    attributes: kv({ "mcp.method": "tools/call", "mcp.tool": "skill_combine", "swarm.step.id": "skill_combine", "trace.id": T, "span.id": spanId }),
  }] }] }] });
}
// botz-mcp server span: its own span id (the one it echoes), parented on what swarm sent.
const server = JSON.stringify({ resourceSpans: [{ resource: { attributes: kv({ "service.name": "botz-mcp", "run.id": "run1" }) }, scopeSpans: [{ spans: [{
  name: "mcp.tool.skill_combine", traceId: T, spanId: "b7ad6b7169203331", parentSpanId: "00f067aa0ba902b7", kind: 2,
  startTimeUnixNano: ns(10), endTimeUnixNano: ns(90), attributes: kv({ "mcp.tool.name": "skill_combine" }),
}] }] }] });

describe("botz-mcp server spans join under the client span", () => {
  it("client keyed by the SENT span id → server span counted and nested", () => {
    const idx = buildTraceIndex("run1", [client("00f067aa0ba902b7"), server]);
    const spans = idx.byTrace.get(T) ?? [];
    expect(spans.filter((s) => !s.client)).toHaveLength(1);
    const srv = spans.find((s) => !s.client)!;
    const cli = spans.find((s) => s.client)!;
    expect(srv.parentSpanId).toBe(cli.spanId);
  });
  it("regression: client keyed by the server's ECHOED span id leaves the server span unparented", () => {
    const idx = buildTraceIndex("run1", [client("b7ad6b7169203331"), server]);
    const spans = idx.byTrace.get(T) ?? [];
    const cli = spans.find((s) => s.client)!;
    const srv = spans.find((s) => !s.client)!;
    expect(srv.parentSpanId).not.toBe(cli.spanId);
    expect(srv.spanId).toBe(cli.spanId); // same id on both sides: no parent/child relationship possible
  });
});
