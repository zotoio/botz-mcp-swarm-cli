import { describe, expect, it } from "vitest";
import { payloadErrorMessage } from "./payload-error.js";
import type { McpCallResult } from "../adapters/base.js";

function okResult(result: unknown): McpCallResult {
  return {
    success: true,
    errorClass: "none",
    latencyMs: 1,
    bytesIn: 0,
    bytesOut: 0,
    result,
  };
}

describe("payloadErrorMessage", () => {
  it("ignores transport and protocol failures", () => {
    expect(payloadErrorMessage({ ...okResult({}), success: false, errorClass: "protocol" })).toBeNull();
  });

  it("detects status error JSON", () => {
    const message = payloadErrorMessage(
      okResult({ content: [{ type: "text", text: '{"status":"error","message":"boom"}' }] }),
    );
    expect(message).toContain("boom");
  });

  it("detects top-level error field", () => {
    const message = payloadErrorMessage(
      okResult({ content: [{ type: "text", text: '{"error":"nope"}' }] }),
    );
    expect(message).toContain("nope");
  });

  it("accepts genuine success JSON", () => {
    expect(payloadErrorMessage(okResult({ content: [{ type: "text", text: '{"status":"ok","data":1}' }] }))).toBeNull();
  });
});
