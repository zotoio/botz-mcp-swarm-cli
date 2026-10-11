import http2 from "node:http2";

export type TransportKind = "http2" | "sse";

export type AssignFrame = {
  type: "assign";
  executionId?: unknown;
  projectId?: unknown;
  suiteId?: unknown;
  version?: unknown;
};

export type ServerFrame =
  | { type: "ready"; tokenId?: string; label?: string; transport?: TransportKind; channelId?: string }
  | AssignFrame
  | { type: "withdraw"; executionId: string; reason: string }
  | { type: "ack"; executionId: string; frame: string; ok: boolean; error?: string }
  | { type: "error"; error: string }
  | { type: "ping" };

export type WorkerFrame =
  | { type: "accept"; executionId: string }
  | { type: "progress"; executionId: string; event: { name: string; attributes: Record<string, string | number | boolean> } }
  | { type: "complete"; executionId: string; verdict: "pass" | "fail"; report?: unknown }
  | { type: "reject"; executionId: string; reason: string };

export type SendResult = { ok: true } | { ok: false; error: string };
export type SuiteResult = { ok: true; payload: unknown } | { ok: false; status: number; error: string };
/** Why the frame stream ended. `revoked` and `unauthorized` mean this token must not reconnect. */
export type CloseReason = { kind: "revoked" } | { kind: "unauthorized" } | { kind: "disconnected"; error: string } | { kind: "stopped" };

export interface WorkerTransport {
  readonly kind: TransportKind;
  /** Server frames in order, starting with `ready`. Acks are consumed by `send`. Ends when the stream closes. */
  frames(): AsyncIterable<ServerFrame>;
  send(frame: WorkerFrame): Promise<SendResult>;
  fetchSuite(executionId: string): Promise<SuiteResult>;
  /** Set once `frames()` has ended. */
  closeReason(): CloseReason | null;
  close(): void;
}

/** The server answered with 401: the token is unknown or revoked. */
export class WorkerAuthError extends Error {}
/** HTTP/2 could not be used (no ALPN h2, an HTTP/1-only server, or 426). The SSE path may still work. */
export class WorkerProtocolError extends Error {}

export interface ConnectOptions {
  server: string;
  token: string;
  /** Connect and first-response timeout. */
  timeoutMs?: number;
  /**
   * Close the stream when nothing arrives for this long. The service sends `ping` (HTTP/2) or a
   * `: keepalive` comment (SSE) every 15 s, so the default allows three missed beats.
   */
  idleTimeoutMs?: number;
}

export const DEFAULT_IDLE_TIMEOUT_MS = 45_000;

/** Calls `onIdle` once when `touch` has not been called for `ms`. */
function idleWatchdog(ms: number, onIdle: () => void): { touch: () => void; stop: () => void } {
  let timer: NodeJS.Timeout | null = null;
  const touch = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onIdle();
    }, ms);
    timer.unref?.();
  };
  touch();
  return {
    touch,
    stop: () => {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

function idleError(ms: number): string {
  return `no data from the server for ${Math.round(ms / 1000)}s (missed keepalives)`;
}

const ACCEPT_JSON = "application/json";
const FRAME_LIMIT = 8 * 1024 * 1024;

/** Origin of `--server`. Credentials in the URL are refused so they are never logged. */
export function serverOrigin(server: string): URL {
  let url: URL;
  try {
    url = new URL(server);
  } catch {
    throw new Error(`--server must be an http:// or https:// URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`--server must be an http:// or https:// URL`);
  if (url.username || url.password) throw new Error("--server must not contain credentials; pass the worker token with --token or SWARM_WORKER_TOKEN");
  return new URL(url.origin);
}

export function parseFrame(text: string): ServerFrame | null {
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const type = (value as { type?: unknown }).type;
    return typeof type === "string" ? (value as ServerFrame) : null;
  } catch {
    return null;
  }
}

/** Split NDJSON (`\n`) or SSE (`data:` events separated by a blank line) text into frames. */
export class FrameDecoder {
  private buffer = "";

  constructor(private readonly format: "ndjson" | "sse") {}

  push(text: string): ServerFrame[] {
    this.buffer += text.replace(/\r\n/g, "\n");
    if (this.buffer.length > FRAME_LIMIT * 2) throw new Error("frame_too_large");
    const sep = this.format === "sse" ? "\n\n" : "\n";
    const frames: ServerFrame[] = [];
    let at = this.buffer.indexOf(sep);
    while (at >= 0) {
      const chunk = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + sep.length);
      at = this.buffer.indexOf(sep);
      const body = this.format === "sse"
        ? chunk.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n")
        : chunk;
      if (!body.trim()) continue;
      const frame = parseFrame(body.trim());
      if (frame) frames.push(frame);
    }
    return frames;
  }
}

/** Push-to-pull queue behind `frames()`. */
class FrameQueue {
  private readonly items: ServerFrame[] = [];
  private waiter: ((value: IteratorResult<ServerFrame>) => void) | null = null;
  private ended = false;

  push(frame: ServerFrame): void {
    if (this.ended) return;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve({ value: frame, done: false });
    } else {
      this.items.push(frame);
    }
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve({ value: undefined, done: true });
    }
  }

  async *iterate(): AsyncGenerator<ServerFrame> {
    for (;;) {
      const item = this.items.shift();
      if (item) {
        yield item;
        continue;
      }
      if (this.ended) return;
      const next = await new Promise<IteratorResult<ServerFrame>>((resolve) => (this.waiter = resolve));
      if (next.done) return;
      yield next.value;
    }
  }
}

function errorText(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed.error === "string") return parsed.error;
  } catch {
    // Not JSON.
  }
  return body.slice(0, 200) || "no body";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Bidirectional NDJSON over `POST /api/worker/session`. Cleartext uses prior knowledge; https negotiates h2 by ALPN. */
export async function connectHttp2(options: ConnectOptions): Promise<WorkerTransport> {
  const origin = serverOrigin(options.server);
  const timeoutMs = options.timeoutMs ?? 10_000;
  const session = http2.connect(origin, origin.protocol === "https:" ? { ALPNProtocols: ["h2"] } : {});
  const queue = new FrameQueue();
  const acks: Array<(result: SendResult) => void> = [];
  let reason: CloseReason | null = null;
  let channelId = "";

  let finish = (next: CloseReason) => {
    if (!reason) reason = next;
    for (const pending of acks.splice(0)) pending({ ok: false, error: "disconnected" });
    queue.end();
  };

  const onEarlyError = (error: Error) => earlyFail?.(new WorkerProtocolError(`HTTP/2 unavailable: ${messageOf(error)}`));
  const onEarlyClose = () => earlyFail?.(new WorkerProtocolError("HTTP/2 session closed before a response"));
  let earlyFail: ((error: Error) => void) | null = null;
  session.on("error", onEarlyError);
  session.on("close", onEarlyClose);
  const stream = await new Promise<http2.ClientHttp2Stream>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => fail(new WorkerProtocolError("HTTP/2 session did not answer in time")), timeoutMs);
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      session.destroy();
      reject(error);
    };
    earlyFail = fail;
    let req: http2.ClientHttp2Stream;
    try {
      req = session.request({
        ":method": "POST",
        ":path": "/api/worker/session",
        authorization: `Bearer ${options.token}`,
        "content-type": "application/x-ndjson",
        accept: "application/x-ndjson",
      }, { endStream: false });
    } catch (error) {
      fail(new WorkerProtocolError(`HTTP/2 unavailable: ${messageOf(error)}`));
      return;
    }
    req.on("error", (error) => {
      if (!settled) fail(new WorkerProtocolError(`HTTP/2 unavailable: ${messageOf(error)}`));
      else finish({ kind: "disconnected", error: messageOf(error) });
    });
    req.once("response", (head) => {
      const status = Number(head[":status"]);
      if (status === 200) {
        settled = true;
        clearTimeout(timer);
        resolve(req);
        return;
      }
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => (body += chunk));
      req.on("end", () => {
        const error = errorText(body);
        if (status === 401) fail(new WorkerAuthError("worker token was rejected (401 unauthorized)"));
        else if (status === 426 || status === 404 || status === 405) fail(new WorkerProtocolError(`HTTP/2 session refused: ${status} ${error}`));
        else fail(new Error(`worker session failed: ${status} ${error}`));
      });
    });
  });

  session.off("error", onEarlyError);
  session.off("close", onEarlyClose);
  session.on("error", (error) => finish({ kind: "disconnected", error: messageOf(error) }));
  session.on("close", () => finish({ kind: "disconnected", error: "session closed" }));

  const idleMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const watchdog = idleWatchdog(idleMs, () => {
    finish({ kind: "disconnected", error: idleError(idleMs) });
    session.destroy();
  });
  const finishSession = finish;
  finish = (next: CloseReason) => {
    watchdog.stop();
    finishSession(next);
  };

  const decoder = new FrameDecoder("ndjson");
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    watchdog.touch();
    let frames: ServerFrame[];
    try {
      frames = decoder.push(chunk);
    } catch (error) {
      finish({ kind: "disconnected", error: messageOf(error) });
      session.destroy();
      return;
    }
    for (const frame of frames) {
      if (frame.type === "ack") {
        acks.shift()?.(frame.ok ? { ok: true } : { ok: false, error: frame.error ?? "rejected" });
        continue;
      }
      if (frame.type === "ready" && typeof frame.channelId === "string") channelId = frame.channelId;
      if (frame.type === "error" && frame.error === "token_revoked") finish({ kind: "revoked" });
      queue.push(frame);
    }
  });
  stream.on("end", () => {
    finish({ kind: "disconnected", error: "stream ended" });
    session.close();
  });
  stream.on("close", () => finish({ kind: "disconnected", error: "stream closed" }));

  return {
    kind: "http2",
    frames: () => queue.iterate(),
    closeReason: () => reason,
    send(frame) {
      if (reason || stream.destroyed || stream.writableEnded) return Promise.resolve({ ok: false, error: "disconnected" });
      return new Promise<SendResult>((resolve) => {
        acks.push(resolve);
        stream.write(`${JSON.stringify(frame)}\n`);
      });
    },
    fetchSuite(executionId) {
      return new Promise<SuiteResult>((resolve) => {
        if (session.destroyed || session.closed) {
          resolve({ ok: false, status: 0, error: "disconnected" });
          return;
        }
        const req = session.request({
          ":method": "GET",
          ":path": `/api/worker/executions/${encodeURIComponent(executionId)}/suite`,
          authorization: `Bearer ${options.token}`,
          accept: ACCEPT_JSON,
          ...(channelId ? { "x-worker-channel": channelId } : {}),
        });
        let status = 0;
        let body = "";
        req.setEncoding("utf8");
        req.on("response", (head) => (status = Number(head[":status"])));
        req.on("data", (chunk: string) => (body += chunk));
        req.on("error", (error) => resolve({ ok: false, status: 0, error: messageOf(error) }));
        req.on("end", () => resolve(suiteResult(status, body)));
      });
    },
    close() {
      finish({ kind: "stopped" });
      if (!stream.destroyed) stream.close(http2.constants.NGHTTP2_CANCEL);
      session.close();
      setTimeout(() => session.destroy(), 1000).unref();
    },
  };
}

function suiteResult(status: number, body: string): SuiteResult {
  if (status === 200) {
    try {
      return { ok: true, payload: JSON.parse(body) as unknown };
    } catch {
      return { ok: false, status, error: "invalid_suite_json" };
    }
  }
  return { ok: false, status, error: errorText(body) };
}

/** `GET /api/worker/events` for server frames; worker frames are POSTed to `/api/worker/executions/:executionId`. */
export async function connectSse(options: ConnectOptions): Promise<WorkerTransport> {
  const origin = serverOrigin(options.server);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  let res: Response;
  try {
    res = await fetch(new URL("/api/worker/events", origin), {
      headers: { authorization: `Bearer ${options.token}`, accept: "text/event-stream" },
      signal: controller.signal,
    });
  } catch (error) {
    throw new Error(`SSE connect failed: ${messageOf(error)}`);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401) {
    await res.body?.cancel().catch(() => undefined);
    throw new WorkerAuthError("worker token was rejected (401 unauthorized)");
  }
  if (res.status !== 200 || !res.body) {
    const body = await res.text().catch(() => "");
    throw new Error(`SSE connect failed: ${res.status} ${errorText(body)}`);
  }

  const queue = new FrameQueue();
  let reason: CloseReason | null = null;
  let channelId = "";
  const idleMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const watchdog = idleWatchdog(idleMs, () => {
    finish({ kind: "disconnected", error: idleError(idleMs) });
    controller.abort();
  });
  const finish = (next: CloseReason) => {
    watchdog.stop();
    if (!reason) reason = next;
    queue.end();
  };
  const body = res.body;
  void (async () => {
    const decoder = new FrameDecoder("sse");
    const text = new TextDecoder();
    try {
      for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
        watchdog.touch();
        for (const frame of decoder.push(text.decode(chunk, { stream: true }))) {
          if (frame.type === "ready" && typeof frame.channelId === "string") channelId = frame.channelId;
          if (frame.type === "error" && frame.error === "token_revoked") finish({ kind: "revoked" });
          queue.push(frame);
        }
      }
      finish({ kind: "disconnected", error: "event stream ended" });
    } catch (error) {
      finish({ kind: "disconnected", error: messageOf(error) });
    }
  })();

  const headers = () => ({
    authorization: `Bearer ${options.token}`,
    accept: ACCEPT_JSON,
    ...(channelId ? { "x-worker-channel": channelId } : {}),
  });

  return {
    kind: "sse",
    frames: () => queue.iterate(),
    closeReason: () => reason,
    async send(frame) {
      if (!frame.executionId) return { ok: false, error: "invalid_frame" };
      try {
        const post = await fetch(new URL(`/api/worker/executions/${encodeURIComponent(frame.executionId)}`, origin), {
          method: "POST",
          headers: { ...headers(), "content-type": ACCEPT_JSON },
          body: JSON.stringify(frame),
        });
        const text = await post.text();
        if (post.status === 401) finish({ kind: "unauthorized" });
        return post.ok ? { ok: true } : { ok: false, error: errorText(text) };
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
    },
    async fetchSuite(executionId) {
      try {
        const got = await fetch(new URL(`/api/worker/executions/${encodeURIComponent(executionId)}/suite`, origin), { headers: headers() });
        return suiteResult(got.status, await got.text());
      } catch (error) {
        return { ok: false, status: 0, error: messageOf(error) };
      }
    },
    close() {
      finish({ kind: "stopped" });
      controller.abort();
      void body.cancel().catch(() => undefined);
    },
  };
}
