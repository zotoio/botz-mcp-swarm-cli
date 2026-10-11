import { mergeHeaders } from "./headers.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Target } from "../types/manifest.js";
import { createCapturingFetch } from "./http-fetch.js";
import { createMcpSession } from "./mcp-session.js";
import type { McpSession } from "./base.js";

export async function createSseSession(
  target: Target,
  headers?: Record<string, string>,
): Promise<McpSession> {
  if (target.transport !== "sse") {
    throw new Error("Expected SSE transport target");
  }
  const url = new URL(target.url);
  const mergedHeaders = mergeHeaders(target.headers, headers);
  const { fetchFn, capture } = createCapturingFetch();
  const transport = new SSEClientTransport(url, {
    requestInit: Object.keys(mergedHeaders).length
      ? { headers: mergedHeaders }
      : undefined,
    fetch: fetchFn,
  });
  return createMcpSession(transport, {
    getResponseHeaders: () => capture.lastHeaders,
  });
}
