import type { Target } from "../types/manifest.js";
import type { McpSession } from "./base.js";
import { createStdioSession } from "./stdio.js";
import { createSseSession } from "./sse.js";
import { createStreamableHttpSession, withLegacyEra } from "./streamable-http.js";

import { refreshOAuthTokenIfNeeded } from "../core/mcp-oauth.js";

export async function createSession(
  rawTarget: Target,
  headers?: Record<string, string>,
  baseDir?: string,
  onStderr?: (line: string) => void,
): Promise<McpSession> {
  const target = await refreshOAuthTokenIfNeeded(rawTarget);
  const requested = target.protocolEra ?? "auto";
  if (target.transport !== "streamable-http" && requested === "modern") {
    // Modern (2026-07-28) is implemented for Streamable HTTP only; see docs/protocol-eras.md.
    throw new Error(`protocol era 'modern' is not supported on the ${target.transport} transport yet`);
  }
  switch (target.transport) {
    case "stdio":
      return withLegacyEra(await createStdioSession(target, baseDir, onStderr), requested,
        requested === "auto" ? "stdio: legacy only in this swarm version" : undefined);
    case "sse":
      // HTTP+SSE is a legacy-only transport by definition.
      return withLegacyEra(await createSseSession(target, headers), requested);
    case "streamable-http":
      return createStreamableHttpSession(target, headers);
    default:
      throw new Error(`Unsupported transport: ${(target as Target).transport}`);
  }
}

export * from "./base.js";

export * from "./modern-session.js";
export { clearProtocolEraCache } from "./streamable-http.js";
