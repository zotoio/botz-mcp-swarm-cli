import { mergeHeaders } from "./headers.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Target } from "../types/manifest.js";
import { createCapturingFetch } from "./http-fetch.js";
import { createMcpSession } from "./mcp-session.js";
import type { McpSession } from "./base.js";

export async function createStreamableHttpSession(
  target: Target,
  headers?: Record<string, string>,
): Promise<McpSession> {
  if (target.transport !== "streamable-http") {
    throw new Error("Expected streamable-http transport target");
  }
  const url = new URL(target.url);
  const mergedHeaders = mergeHeaders(target.headers, headers);
  const { fetchFn, capture } = createCapturingFetch();
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: Object.keys(mergedHeaders).length
      ? { headers: mergedHeaders }
      : undefined,
    fetch: fetchFn,
  });
  return createMcpSession(transport, {
    getResponseHeaders: () => capture.lastHeaders,
  });
}
