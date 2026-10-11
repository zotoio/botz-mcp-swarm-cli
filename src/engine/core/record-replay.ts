import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { Recording, ReplayMode } from "../types/recording.js";
import { redactValue } from "./redaction.js";
import { createSession } from "../adapters/index.js";
import type { Target } from "../types/manifest.js";
import { assertTargetAllowlisted } from "./allowlist.js";
import { resolveStdioTarget } from "./target-resolve.js";
import { sampleArgsForTool, type ToolDescriptor } from "./tool-args.js";

export async function saveRecording(
  recording: Recording,
  outputPath: string,
): Promise<void> {
  const redacted: Recording = {
    ...recording,
    frames: recording.frames.map((frame) => ({
      ...frame,
      payload: redactValue(frame.payload),
    })),
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(redacted, null, 2), "utf8");
}

export async function loadRecording(path: string): Promise<Recording> {
  const content = await readFile(path, "utf8");
  return JSON.parse(content) as Recording;
}

function prepareTarget(target: Target, baseDir?: string): Target {
  if (target.transport === "stdio") {
    return resolveStdioTarget(target, baseDir);
  }
  return target;
}

export async function recordSession(
  target: Target,
  allowlist: string[],
  outputPath: string,
  baseDir?: string,
): Promise<Recording> {
  const resolved = prepareTarget(target, baseDir);
  assertTargetAllowlisted(resolved, allowlist);

  const recording: Recording = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    targetTransport: resolved.transport,
    redactionProfile: "default",
    frames: [],
  };

  const session = await createSession(resolved, undefined, baseDir);

  try {
    const listResult = await session.listTools();
    recording.frames.push({
      timestamp: new Date().toISOString(),
      direction: "request",
      method: "tools/list",
      sessionId: session.id,
      payload: { method: "tools/list" },
    });
    recording.frames.push({
      timestamp: new Date().toISOString(),
      direction: "response",
      method: "tools/list",
      sessionId: session.id,
      payload: listResult.result ?? { error: listResult.errorMessage },
    });

    const tools =
      (listResult.result as { tools?: ToolDescriptor[] })?.tools ?? [];
    if (tools.length > 0) {
      const tool = tools[0];
      const args = sampleArgsForTool(tool);
      const callResult = await session.callTool(tool.name, args);
      recording.frames.push({
        timestamp: new Date().toISOString(),
        direction: "request",
        method: "tools/call",
        sessionId: session.id,
        payload: { method: "tools/call", name: tool.name, arguments: args },
      });
      recording.frames.push({
        timestamp: new Date().toISOString(),
        direction: "response",
        method: "tools/call",
        sessionId: session.id,
        payload: callResult.result ?? { error: callResult.errorMessage },
      });
    }
  } finally {
    await session.close();
  }

  await saveRecording(recording, outputPath);
  return recording;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function replayRecording(
  recordingPath: string,
  target: Target,
  allowlist: string[],
  mode: ReplayMode = "as-recorded",
  paceMs = 100,
  baseDir?: string,
): Promise<{ replayed: number; errors: number }> {
  const resolved = prepareTarget(target, baseDir);
  assertTargetAllowlisted(resolved, allowlist);
  const recording = await loadRecording(recordingPath);
  const session = await createSession(resolved, undefined, baseDir);

  let replayed = 0;
  let errors = 0;

  try {
    for (const frame of recording.frames) {
      if (frame.direction !== "request") continue;

      if (mode === "paced") {
        await sleep(paceMs);
      }

      try {
        if (frame.method === "tools/list") {
          await session.listTools();
        } else if (frame.method === "tools/call") {
          const payload = frame.payload as {
            name?: string;
            arguments?: Record<string, unknown>;
          };
          if (payload.name) {
            await session.callTool(payload.name, payload.arguments ?? {});
          }
        }
        replayed++;
      } catch {
        errors++;
      }

      if (mode === "as-recorded" && paceMs > 0) {
        await sleep(paceMs);
      }
    }
  } finally {
    await session.close();
  }

  return { replayed, errors };
}

export function containsSecrets(recording: Recording): boolean {
  const text = JSON.stringify(recording.frames);
  return /Bearer\s+[A-Za-z0-9]/i.test(text) && !text.includes("[REDACTED]");
}
