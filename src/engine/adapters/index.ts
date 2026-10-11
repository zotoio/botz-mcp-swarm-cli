import type { Target } from "../types/manifest.js";
import type { McpSession } from "./base.js";
import { createStdioSession } from "./stdio.js";
import { createSseSession } from "./sse.js";
import { createStreamableHttpSession } from "./streamable-http.js";

export async function createSession(
  target: Target,
  headers?: Record<string, string>,
  baseDir?: string,
  onStderr?: (line: string) => void,
): Promise<McpSession> {
  switch (target.transport) {
    case "stdio":
      return createStdioSession(target, baseDir, onStderr);
    case "sse":
      return createSseSession(target, headers);
    case "streamable-http":
      return createStreamableHttpSession(target, headers);
    default:
      throw new Error(`Unsupported transport: ${(target as Target).transport}`);
  }
}

export * from "./base.js";
