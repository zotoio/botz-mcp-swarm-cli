import { randomBytes } from "node:crypto";

export const SWARM_TESTER_USER_AGENT = "botz-mcp-swarm/0.15.0 (mcp-tester)";

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
    traceIdHex: traceId,
    spanId,
  } as { traceparent: string; traceId: string; spanId: string };
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
