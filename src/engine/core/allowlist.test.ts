import { describe, it, expect } from "vitest";
import {
  isTargetAllowlisted,
  assertTargetAllowlisted,
  AllowlistError,
} from "@zotoio/botz-mcp-swarm-engine/core/allowlist.js";

describe("allowlist", () => {
  it("allows stdio targets with stdio in allowlist", () => {
    const target = {
      transport: "stdio" as const,
      command: "node",
      args: ["server.js"],
    };
    expect(isTargetAllowlisted(target, ["stdio"])).toBe(true);
  });

  it("allows localhost HTTP targets", () => {
    const target = {
      transport: "streamable-http" as const,
      url: "http://localhost:3100/mcp",
    };
    expect(isTargetAllowlisted(target, ["localhost"])).toBe(true);
  });

  it("rejects non-allowlisted hosts", () => {
    const target = {
      transport: "sse" as const,
      url: "https://evil.example.com/mcp",
    };
    expect(isTargetAllowlisted(target, ["localhost"])).toBe(false);
  });

  it("throws AllowlistError on assert", () => {
    const target = {
      transport: "sse" as const,
      url: "https://evil.example.com/mcp",
    };
    expect(() => assertTargetAllowlisted(target, ["localhost"])).toThrow(
      AllowlistError,
    );
  });
});
