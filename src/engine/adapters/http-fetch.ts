import { randomBytes } from "node:crypto";

export const SWARM_TESTER_USER_AGENT = "botz-mcp-swarm/0.6.0 (mcp-tester)";

export interface HeaderCapture {
  lastHeaders: Record<string, string>;
  lastSentHeaders: Record<string, string>;
}

export function generateW3CTraceparent(): { traceparent: string; traceId: string; spanId: string } {
  const traceId = randomBytes(16).toString("hex");
  const spanId = randomBytes(8).toString("hex");
  return {
    traceparent: `00-${traceId}-${spanId}-01`,
    traceId,
    spanId,
  };
}

export function parseW3CTraceparent(raw: string | undefined): { traceId: string; spanId: string } | null {
  if (!raw || typeof raw !== "string") return null;
  const m = raw.trim().match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/i);
  if (!m) return null;
  return { traceId: m[1]!.toLowerCase(), spanId: m[2]!.toLowerCase() };
}

/**
 * The traceparent that identifies swarm's CLIENT span: the one we SENT. A server echoes its own
 * traceparent (same trace id, its server span id) on the response; using that as the client span id
 * made the client and server spans collide and left server spans unparented ("0 server spans").
 */
export function clientTraceparent(sent?: Record<string, string>, received?: Record<string, string>): string | undefined {
  return sent?.traceparent || received?.traceparent || undefined;
}

/** Wraps fetch to inject W3C traceparent + (mcp-tester) User-Agent and capture response headers. */
export function createCapturingFetch(
  baseFetch: typeof fetch = fetch,
): { fetchFn: typeof fetch; capture: HeaderCapture } {
  const capture: HeaderCapture = { lastHeaders: {}, lastSentHeaders: {} };
  const fetchFn = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const outHeaders = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    if (!outHeaders.has("user-agent")) {
      outHeaders.set("user-agent", SWARM_TESTER_USER_AGENT);
    }
    if (!outHeaders.has("x-swarm-client")) {
      outHeaders.set("x-swarm-client", "1");
    }
    if (!outHeaders.has("traceparent")) {
      const { traceparent } = generateW3CTraceparent();
      outHeaders.set("traceparent", traceparent);
    }
    if (!outHeaders.has("tracestate")) {
      outHeaders.set("tracestate", "swarm=client:mcp-tester");
    }
    const sentMap: Record<string, string> = {};
    outHeaders.forEach((value, key) => {
      sentMap[key.toLowerCase()] = value;
    });
    capture.lastSentHeaders = sentMap;

    const nextInit: RequestInit = { ...(init ?? {}), headers: outHeaders };
    const response = await baseFetch(input, nextInit);
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    capture.lastHeaders = headers;
    return response;
  };
  return { fetchFn, capture };
}
