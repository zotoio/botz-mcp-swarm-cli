import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createSession } from "./index.js";
import { clearProtocolEraCache } from "./streamable-http.js";
import { capPayload, eraResultDigest } from "../core/runner.js";

type Handler = (body: { id?: unknown; method?: string; params?: Record<string, unknown> }, headers: Record<string, string | string[] | undefined>) => { status: number; body?: unknown };

let server: Server | undefined;
afterEach(async () => {
  clearProtocolEraCache();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

async function start(handler: Handler): Promise<string> {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const out = handler(body, req.headers);
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(out.body === undefined ? "" : JSON.stringify(out.body));
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  const addr = server.address() as { port: number };
  return `http://127.0.0.1:${addr.port}/mcp`;
}

const modernHandler: Handler = (b, h) => {
  const meta = (b.params?._meta ?? {}) as Record<string, unknown>;
  if (meta["io.modelcontextprotocol/protocolVersion"] !== "2026-07-28" || h["mcp-session-id"]) {
    return { status: 400, body: { jsonrpc: "2.0", id: b.id, error: { code: -32600, message: "bad" } } };
  }
  expect(h["mcp-protocol-version"]).toBe("2026-07-28");
  expect(h["mcp-method"]).toBe(b.method);
  if (b.method === "server/discover") {
    return { status: 200, body: { jsonrpc: "2.0", id: b.id, result: { resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { tools: {} }, ttlMs: 0, cacheScope: "private", _meta: { "io.modelcontextprotocol/serverInfo": { name: "mock-modern", version: "1" } } } } };
  }
  if (b.method === "tools/call") {
    expect(h["mcp-name"]).toBe("add");
    const a = b.params!.arguments as { a: number; b: number };
    return { status: 200, body: { jsonrpc: "2.0", id: b.id, result: { resultType: "complete", structuredContent: { sum: a.a + a.b, ts: Date.now() }, content: [] } } };
  }
  return { status: 404, body: { jsonrpc: "2.0", id: b.id, error: { code: -32601, message: "Method not found" } } };
};

describe("protocol eras", () => {
  it("auto speaks modern to a modern server and records the era", async () => {
    const url = await start(modernHandler);
    const s = await createSession({ transport: "streamable-http", url });
    expect(s.protocolEra).toBe("modern");
    const meta = s.getServerMeta();
    expect(meta.protocolEra).toBe("modern");
    expect(meta.serverInfo?.name).toBe("mock-modern");
    const r = await s.callTool("add", { a: 2, b: 3 });
    expect(r.success).toBe(true);
    expect((r.result as { structuredContent: { sum: number } }).structuredContent.sum).toBe(5);
    const ping = await s.ping();
    expect(ping.success).toBe(false);
    expect(ping.errorClass).toBe("protocol");
  });

  it("auto falls back to legacy with a visible reason when discover is rejected", async () => {
    const url = await start((b) => {
      if (b.method === "initialize") {
        return { status: 200, body: { jsonrpc: "2.0", id: b.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "mock-legacy", version: "1" } } } };
      }
      if (b.method === "notifications/initialized") return { status: 202 };
      if (b.id === undefined) return { status: 202 };
      return { status: 400, body: { jsonrpc: "2.0", id: b.id ?? null, error: { code: -32000, message: "Bad Request: Missing session ID" } } };
    });
    const s = await createSession({ transport: "streamable-http", url, suppressNotificationStream: true });
    expect(s.protocolEra).toBe("legacy");
    const meta = s.getServerMeta();
    expect(meta.requestedEra).toBe("auto");
    expect(meta.eraFallbackReason).toMatch(/server\/discover probe failed/);
    await s.close();
  });

  it("modern pinned against a legacy server fails loudly", async () => {
    const url = await start((b) => ({ status: 400, body: { jsonrpc: "2.0", id: b.id ?? null, error: { code: -32000, message: "Missing session ID" } } }));
    await expect(createSession({ transport: "streamable-http", url, protocolEra: "modern" })).rejects.toThrow(/not modern/);
  });

  it("unsupported version error still identifies a modern server", async () => {
    const url = await start((b) => ({ status: 400, body: { jsonrpc: "2.0", id: b.id, error: { code: -32022, message: "Unsupported protocol version", data: { supported: ["2026-07-28"], requested: "x" } } } }));
    const s = await createSession({ transport: "streamable-http", url });
    expect(s.protocolEra).toBe("modern");
  });

  it("result digests ignore volatile keys and envelope", () => {
    expect(eraResultDigest({ structuredContent: { sum: 5, ts: 1 }, resultType: "complete" }))
      .toBe(eraResultDigest({ structuredContent: { sum: 5, ts: 2 }, _meta: { x: 1 } }));
    expect(eraResultDigest({ structuredContent: { sum: 5 } })).not.toBe(eraResultDigest({ structuredContent: { sum: 6 } }));
  });

  it("response payloads are redacted and size-capped", () => {
    const small = capPayload({ ok: 1, authorization: "Bearer abc" });
    expect(small.truncated).toBe(false);
    expect(JSON.stringify(small.value)).not.toContain("Bearer abc");
    const big = capPayload({ text: "x".repeat(20000) }, 1000);
    expect(big.truncated).toBe(true);
    expect(JSON.stringify(big.value).length).toBeLessThan(1200);
  });
});
