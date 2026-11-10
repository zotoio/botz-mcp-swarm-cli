import { describe, it, expect } from "vitest";
import { normalizePolicy } from "./policy.js";
import {
  allowlistIncludes,
  normalizeAllowlistEntries,
  parseAllowlistEntryJson,
} from "./mcp-allowlist.js";

describe("admin allowlist policy CRUD", () => {
  it("normalizes legacy host strings alongside MCP configs", () => {
    const policy = normalizePolicy({
      targetAllowlist: [
        "stdio",
        "localhost",
        { transport: "sse", url: "https://mcp.example.com/sse" },
      ],
      gatewayAllowlist: ["edge-gw"],
    });
    expect(policy.targetAllowlist).toHaveLength(3);
    expect(policy.targetAllowlist[0]).toBe("stdio");
    expect(policy.gatewayAllowlist).toContain("edge-gw");
  });

  it("parses structured MCP config for admin add API", () => {
    const config = {
      transport: "streamable-http" as const,
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer test" },
    };
    const parsed = parseAllowlistEntryJson(JSON.stringify(config));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.entry).toMatchObject({
      transport: "streamable-http",
      url: "https://mcp.example.com/mcp",
    });
  });

  it("dedupes allowlist entries by key", () => {
    const entries = normalizeAllowlistEntries(
      ["stdio", { transport: "stdio", command: "node" }],
      [],
    );
    expect(allowlistIncludes(entries, "stdio")).toBe(true);
    expect(
      allowlistIncludes(entries, { transport: "stdio", command: "node" }),
    ).toBe(true);
  });
});
