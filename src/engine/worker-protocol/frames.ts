/**
 * Shared worker wire frames (types + codecs). No HTTP client or server.
 */

export type TransportKind = "http2" | "sse";

export type VuSliceAssignment = {
  shardIndex: number;
  totalShards: number;
  assignedVus: number;
};

export type AssignFrame = {
  type: "assign";
  executionId: string;
  projectId: string;
  suiteId: string;
  version: number;
  vuSlice?: VuSliceAssignment;
};

export type ServerFrame =
  | {
      type: "ready";
      tokenId: string;
      label: string;
      transport: TransportKind;
      channelId: string;
    }
  | AssignFrame
  | {
      type: "withdraw";
      executionId: string;
      reason: "accepted_elsewhere" | "accept_timeout" | "execution_timeout" | "cancelled" | string;
    }
  | { type: "ack"; executionId: string; frame: string; ok: true }
  | { type: "ack"; executionId: string; frame: string; ok: false; error: string }
  | { type: "error"; error: string }
  | { type: "ping" };

export type WorkerFrame =
  | { type: "accept"; executionId: string; maxVus?: number; capabilities?: string[] }
  | {
      type: "progress";
      executionId: string;
      event: { name: string; attributes: Record<string, string | number | boolean> };
    }
  | { type: "complete"; executionId: string; verdict: "pass" | "fail"; report?: unknown }
  | { type: "reject"; executionId: string; reason: string };

const FRAME_MAX_BYTES = 256 * 1024;

/** Parse one JSON line frame; returns null on empty or invalid input. */
export function parseWorkerJsonLine(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (Buffer.byteLength(trimmed, "utf8") > FRAME_MAX_BYTES) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

export function serializeWorkerFrame(frame: WorkerFrame | ServerFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

export function isAssignFrame(value: unknown): value is AssignFrame {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as AssignFrame).type === "assign" &&
    typeof (value as AssignFrame).executionId === "string"
  );
}
