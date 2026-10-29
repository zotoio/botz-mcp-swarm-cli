import { mergeHeaders } from "./headers.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Target } from "../types/manifest.js";
import { createCapturingFetch } from "./http-fetch.js";
import { createMcpSession } from "./mcp-session.js";
import type { McpSession } from "./base.js";
import { createModernRpc, createModernSession, probeProtocolEra } from "./modern-session.js";

type HttpTarget = Extract<Target, { transport: "sse" | "streamable-http" }>;

/**
 * Process-wide cache of the era detected per origin+path (spec: clients SHOULD
 * cache the era for the HTTP origin). Re-probed when the cached era fails.
 */
const eraCache = new Map<string, { era: "legacy" | "modern"; reason?: string; at: number }>();
const ERA_CACHE_MS = 10 * 60_000;

export function clearProtocolEraCache(): void {
  eraCache.clear();
}

/** Stop the legacy SDK transport from opening its standalone GET notification stream. */
function suppressGetStream(t: StreamableHTTPClientTransport): void {
  const anyT = t as unknown as { _startOrAuthSse: (opts: { resumptionToken?: string }) => Promise<void> };
  const orig = anyT._startOrAuthSse.bind(t);
  // Resumption of a POST response stream still works; only the unsolicited GET is skipped.
  anyT._startOrAuthSse = async (opts) => (opts?.resumptionToken ? orig(opts) : undefined);
}

export async function createStreamableHttpSession(
  target: Target,
  headers?: Record<string, string>,
): Promise<McpSession> {
  if (target.transport !== "streamable-http") {
    throw new Error("Expected streamable-http transport target");
  }
  const t = target as HttpTarget;
  const requested = t.protocolEra ?? "auto";
  const url = new URL(t.url);
  const mergedHeaders = mergeHeaders(t.headers, headers);
  const { fetchFn, capture } = createCapturingFetch();

  let fallbackReason: string | undefined;
  if (requested !== "legacy") {
    const key = `${url.origin}${url.pathname}`;
    const cached = requested === "auto" ? eraCache.get(key) : undefined;
    const rpc = createModernRpc(url, mergedHeaders, fetchFn, capture);
    if (cached && Date.now() - cached.at < ERA_CACHE_MS && cached.era === "legacy") {
      fallbackReason = cached.reason ?? "cached: server is legacy-only";
    } else {
      const probe = await probeProtocolEra(rpc);
      if (probe.era === "modern") {
        eraCache.set(key, { era: "modern", at: Date.now() });
        const rpcAt = probe.protocolVersion === "2026-07-28"
          ? rpc
          : createModernRpc(url, mergedHeaders, fetchFn, capture, probe.protocolVersion);
        return createModernSession(rpcAt, probe.discover, probe.protocolVersion, { requestedEra: requested });
      }
      if (requested === "modern") {
        throw new Error(`protocol era 'modern' pinned but the server is not modern: ${probe.reason}`);
      }
      fallbackReason = probe.reason;
      eraCache.set(key, { era: "legacy", reason: probe.reason, at: Date.now() });
    }
  }

  const makeTransport = () => {
    const tr = new StreamableHTTPClientTransport(url, {
      requestInit: Object.keys(mergedHeaders).length
        ? { headers: mergedHeaders }
        : undefined,
      fetch: fetchFn,
    });
    if (t.suppressNotificationStream) suppressGetStream(tr);
    return tr;
  };
  const session = await createMcpSession(makeTransport(), {
    getResponseHeaders: () => capture.lastHeaders,
  });
  return withLegacyEra(session, requested, fallbackReason);
}

/** Tag a legacy-handshake session with its era + (for Auto) the fallback reason. */
export function withLegacyEra(
  session: McpSession,
  requested: "legacy" | "auto" | "modern",
  fallbackReason?: string,
): McpSession {
  const getMeta = session.getServerMeta.bind(session);
  return Object.assign(session, {
    protocolEra: "legacy" as const,
    requestedEra: requested,
    ...(fallbackReason ? { eraFallbackReason: fallbackReason } : {}),
    getServerMeta: () => ({
      ...getMeta(),
      protocolEra: "legacy" as const,
      requestedEra: requested,
      ...(fallbackReason ? { eraFallbackReason: fallbackReason } : {}),
    }),
  });
}
