import { describe, expect, it, vi } from "vitest";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { createMcpSession } from "./mcp-session.js";

/** Minimal server-side fake: answers initialize with a fixed (older) protocol version. */
function fakeTransport(opts: { protocolVersion: string; sessionId?: string; terminate?: () => Promise<void> }) {
  const t: Transport & { sessionId?: string; terminateSession?: () => Promise<void>; seenVersion?: string } = {
    sessionId: opts.sessionId,
    async start() {},
    async close() {},
    async send(message: JSONRPCMessage) {
      if ("method" in message && message.method === "initialize" && "id" in message) {
        queueMicrotask(() =>
          t.onmessage?.({
            jsonrpc: "2.0",
            id: message.id,
            result: { protocolVersion: opts.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } },
          } as JSONRPCMessage),
        );
      }
    },
  };
  if (opts.terminate) t.terminateSession = opts.terminate;
  return t;
}

describe("mcp session protocol handling", () => {
  it("reports the negotiated protocol version, not the SDK latest", async () => {
    const transport = fakeTransport({ protocolVersion: "2025-06-18" });
    const session = await createMcpSession(transport);
    expect(session.getServerMeta().protocolVersion).toBe("2025-06-18");
    await session.close();
  });

  it("sends the session-ending DELETE (terminateSession) on Streamable HTTP close", async () => {
    const terminate = vi.fn(async () => {});
    const session = await createMcpSession(fakeTransport({ protocolVersion: "2025-11-25", sessionId: "s-1", terminate }));
    await session.close();
    expect(terminate).toHaveBeenCalledTimes(1);
  });

  it("skips terminateSession when the server issued no session id", async () => {
    const terminate = vi.fn(async () => {});
    const session = await createMcpSession(fakeTransport({ protocolVersion: "2025-11-25", terminate }));
    await session.close();
    expect(terminate).not.toHaveBeenCalled();
  });

  it("automatically reconnects and retries once when a Streamable HTTP session is lost mid-run (-32600 Session not found)", async () => {
    let toolAttempts = 0;
    const makeFakeSessionTransport = (sid: string, failFirstCall: boolean) => {
      const t: Transport & { sessionId?: string } = {
        sessionId: sid,
        async start() {},
        async close() {},
        async send(message: JSONRPCMessage) {
          if ("method" in message && message.method === "initialize" && "id" in message) {
            queueMicrotask(() =>
              t.onmessage?.({
                jsonrpc: "2.0",
                id: message.id,
                result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } },
              } as JSONRPCMessage),
            );
            return;
          }
          if ("method" in message && message.method === "tools/call" && "id" in message) {
            toolAttempts += 1;
            if (failFirstCall && toolAttempts === 1) {
              queueMicrotask(() =>
                t.onmessage?.({
                  jsonrpc: "2.0",
                  id: message.id,
                  error: { code: -32600, message: "Session not found" },
                } as JSONRPCMessage),
              );
              return;
            }
            queueMicrotask(() =>
              t.onmessage?.({
                jsonrpc: "2.0",
                id: message.id,
                result: { content: [{ type: "text", text: `ok from ${sid}` }] },
              } as JSONRPCMessage),
            );
          }
        },
      };
      return t;
    };

    const t1 = makeFakeSessionTransport("s-dropped", true);
    const t2 = makeFakeSessionTransport("s-reconnected", false);
    const recreateTransport = vi.fn(() => t2);

    const session = await createMcpSession(t1, { recreateTransport });
    const res = await session.callTool("skill_get", { name: "demo" });
    expect(res.success).toBe(true);
    expect(recreateTransport).toHaveBeenCalledTimes(1);
    expect(toolAttempts).toBe(2);
    expect((res.result as { content?: Array<{ text?: string }> })?.content?.[0]?.text).toBe("ok from s-reconnected");
    await session.close();
  });
});
