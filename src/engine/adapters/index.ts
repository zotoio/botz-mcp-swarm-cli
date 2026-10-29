import type { Target } from "../types/manifest.js";
import type { McpSession } from "./base.js";
import { createStdioSession } from "./stdio.js";
import { createSseSession } from "./sse.js";
import { createStreamableHttpSession, withLegacyEra } from "./streamable-http.js";

export async function createSession(
  target: Target,
  headers?: Record<string, string>,
  baseDir?: string,
  onStderr?: (line: string) => void,
): Promise<McpSession> {
  const requested = target.protocolEra ?? "auto";
  if (target.transport !== "streamable-http" && requested === "modern") {
    throw new Error(`protocol era 'modern' is not supported on the ${target.transport} transport yet`);
  }
  switch (target.transport) {
    case "stdio":
      return withLegacyEra(await createStdioSession(target, baseDir, onStderr), requested,
        requested === "auto" ? "stdio: legacy only in this swarm version" : undefined);
    case "sse":
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
