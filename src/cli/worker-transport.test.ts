import http from "node:http";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { connectHttp2, connectSse, FrameDecoder, parseFrame, serverOrigin, type ServerFrame, type WorkerTransport } from "./worker-transport.js";

const TOKEN = ["bzw", "W".repeat(43)].join("_");
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** Fake service: sends `ready`, then a heartbeat every `beatMs` (or nothing when 0). */
function fakeService(kind: "http2" | "sse", beatMs: number): Promise<string> {
  const ready = JSON.stringify({ type: "ready", label: "fake", transport: kind, channelId: "00000000-0000-4000-8000-000000000000" });
  const timers: NodeJS.Timeout[] = [];
  if (kind === "http2") {
    const server = http2.createServer();
    server.on("stream", (stream) => {
      stream.respond({ ":status": 200, "content-type": "application/x-ndjson" });
      stream.write(`${ready}\n`);
      if (beatMs > 0) timers.push(setInterval(() => !stream.destroyed && stream.write('{"type":"ping"}\n'), beatMs));
      stream.on("error", () => undefined);
    });
    cleanups.push(() => {
      timers.forEach(clearInterval);
      server.close();
    });
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
  }
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${ready}\n\n`);
    if (beatMs > 0) timers.push(setInterval(() => !res.writableEnded && res.write(": keepalive\n\n"), beatMs));
  });
  cleanups.push(() => {
    timers.forEach(clearInterval);
    server.closeAllConnections();
    server.close();
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

async function drain(transport: WorkerTransport): Promise<ServerFrame[]> {
  const frames: ServerFrame[] = [];
  for await (const frame of transport.frames()) frames.push(frame);
  return frames;
}

describe("worker stream idle watchdog", () => {
  for (const kind of ["http2", "sse"] as const) {
    const connect = kind === "http2" ? connectHttp2 : connectSse;

    it(`${kind}: closes a silent stream after the idle timeout`, async () => {
      const server = await fakeService(kind, 0);
      const transport = await connect({ server, token: TOKEN, idleTimeoutMs: 150 });
      const started = Date.now();
      const frames = await drain(transport);
      expect(frames[0]).toMatchObject({ type: "ready" });
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(transport.closeReason()).toMatchObject({ kind: "disconnected", error: expect.stringContaining("missed keepalives") });
    });

    it(`${kind}: heartbeats keep the stream open`, async () => {
      const server = await fakeService(kind, 30);
      const transport = await connect({ server, token: TOKEN, idleTimeoutMs: 150 });
      const frames = drain(transport);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(transport.closeReason()).toBeNull();
      transport.close();
      await frames;
      expect(transport.closeReason()).toEqual({ kind: "stopped" });
    });
  }
});

describe("worker frame parsing", () => {
  it("splits NDJSON across chunk boundaries and skips blank or invalid lines", () => {
    const decoder = new FrameDecoder("ndjson");
    expect(decoder.push('{"type":"ready","channelId":"c1"}\n{"type":"as')).toEqual([{ type: "ready", channelId: "c1" }]);
    expect(decoder.push('sign","executionId":"e1"}\n\nnot json\n[1]\n{"type":"ping"}\n')).toEqual([
      { type: "assign", executionId: "e1" },
      { type: "ping" },
    ]);
  });

  it("reads SSE data events, ignores comments, and accepts CRLF", () => {
    const decoder = new FrameDecoder("sse");
    expect(decoder.push(": connected\n\ndata: {\"type\":\"ready\",\"transport\":\"sse\"}\r\n\r\n: keepalive\n\ndata: {\"type\":\"with")).toEqual([
      { type: "ready", transport: "sse" },
    ]);
    expect(decoder.push('draw","executionId":"e1","reason":"accept_timeout"}\n\n')).toEqual([
      { type: "withdraw", executionId: "e1", reason: "accept_timeout" },
    ]);
  });

  it("requires an object frame with a type", () => {
    expect(parseFrame('{"executionId":"e1"}')).toBeNull();
    expect(parseFrame("null")).toBeNull();
    expect(parseFrame('{"type":"ping"}')).toEqual({ type: "ping" });
  });

  it("takes the origin of --server and refuses credentials in it", () => {
    expect(serverOrigin("https://swarm.example.com/admin/").href).toBe("https://swarm.example.com/");
    expect(() => serverOrigin("ftp://swarm.example.com")).toThrow(/http/);
    expect(() => serverOrigin("https://user:pw@swarm.example.com")).toThrow(/credentials/);
  });
});
