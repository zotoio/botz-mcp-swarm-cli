import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createMcpSession } from "./mcp-session.js";
import type { McpSession } from "./base.js";
import type { Target } from "../types/manifest.js";
import {
  buildStdioEnv,
  resolveStdioTarget,
} from "../core/target-resolve.js";

export async function createStdioSession(
  target: Target,
  baseDir?: string,
  onStderr?: (line: string) => void,
): Promise<McpSession> {
  if (target.transport !== "stdio") {
    throw new Error("Expected stdio transport target");
  }

  const resolved = resolveStdioTarget(target, baseDir);
  if (resolved.transport !== "stdio") {
    throw new Error("Expected stdio transport target");
  }
  const transport = new StdioClientTransport({
    command: resolved.command,
    args: resolved.args,
    env: buildStdioEnv(resolved.env),
    cwd: resolved.cwd,
    stderr: "pipe",
  });

  // Capture stderr as a log surface (stdio MCP servers often log here).
  const stderrLines: string[] = [];
  const stderr = transport.stderr;
  if (stderr) {
    stderr.on("data", (chunk: Buffer | string) => {
      const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const line of text.split(/\r?\n/)) {
        if (line.length === 0) continue;
        const capped = line.length > 2000 ? `${line.slice(0, 2000)}…` : line;
        stderrLines.push(capped);
        onStderr?.(capped);
      }
    });
  }

  const session = await createMcpSession(transport, { stderrLines });
  const childPid =
    "pid" in transport
      ? (transport as StdioClientTransport).pid ?? null
      : null;
  return { ...session, childPid, stderrLines };
}
