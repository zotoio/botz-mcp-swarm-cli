import { describe, it, expect } from "vitest";
import {
  allowlistEntryKey,
  allowlistEntryLabel,
  allowlistHosts,
  allowlistIncludes,
  enabledAllowlist,
  normalizeAllowlistEntries,
  parseAllowlistEntryJson,
  retargetDisabledKey,
  toggleDisabledKey,
  validateMcpServerConfig,
} from "./mcp-allowlist.js";

describe("mcp allowlist", () => {
  it("keeps legacy host strings on normalize", () => {
    const entries = normalizeAllowlistEntries(["stdio", "localhost"], []);
    expect(entries).toEqual(["stdio", "localhost"]);
  });

  it("normalizes stdio MCP config", () => {
    const entries = normalizeAllowlistEntries(
      [{ transport: "stdio", command: "node", args: ["server.js"] }],
      [],
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ transport: "stdio", command: "node" });
  });

  it("normalizes HTTP MCP config", () => {
    const entries = normalizeAllowlistEntries(
      [{ transport: "sse", url: "https://mcp.example.com/sse" }],
      [],
    );
    expect(entries[0]).toMatchObject({
      transport: "sse",
      url: "https://mcp.example.com/sse",
    });
  });

  it("validates stdio config requires command", () => {
    const result = validateMcpServerConfig({ transport: "stdio", command: "" });
    expect(result.ok).toBe(false);
  });

  it("parses config JSON for add API", () => {
    const result = parseAllowlistEntryJson(
      JSON.stringify({ transport: "streamable-http", url: "https://api.example/mcp" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry).toMatchObject({ transport: "streamable-http" });
    }
  });

  it("parses legacy host JSON string", () => {
    const result = parseAllowlistEntryJson('"localhost"');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entry).toBe("localhost");
  });

  it("dedupes via allowlistIncludes", () => {
    const entries = normalizeAllowlistEntries(["stdio"], []);
    expect(allowlistIncludes(entries, "stdio")).toBe(true);
    expect(
      allowlistIncludes(entries, { transport: "stdio", command: "node" }),
    ).toBe(false);
  });

  it("labels entries for admin display", () => {
    expect(allowlistEntryLabel("localhost")).toBe("localhost");
    expect(
      allowlistEntryLabel({ transport: "stdio", command: "npx", args: ["-y", "mcp"] }),
    ).toContain("stdio");
  });

  it("flattens structured entries to runtime hosts", () => {
    const hosts = allowlistHosts([
      "stdio",
      { transport: "sse", url: "https://mcp.example.com/sse" },
    ]);
    expect(hosts).toContain("stdio");
    expect(hosts).toContain("mcp.example.com");
  });

  it("uses stable entry keys", () => {
    const key = allowlistEntryKey({
      transport: "stdio",
      command: "node",
      args: ["x.js"],
    });
    expect(key).toBe("stdio:node x.js");
  });

  it("hides disabled keys from the active allowlist and keeps the flag across an edit", () => {
    const entries = [
      { transport: "stdio" as const, command: "mock-server/run.sh" },
      "localhost",
    ];
    const toggled = toggleDisabledKey([], "localhost");
    expect(toggled.enabled).toBe(false);
    expect(enabledAllowlist(entries, toggled.keys)).toEqual([entries[0]]);
    expect(toggleDisabledKey(toggled.keys, "localhost").enabled).toBe(true);
    expect(retargetDisabledKey(["stdio:old"], "stdio:old", "stdio:new")).toEqual(["stdio:new"]);
  });
});
