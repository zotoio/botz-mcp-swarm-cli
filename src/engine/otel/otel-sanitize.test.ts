import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  stripSecretAttributes,
  buildTenantResourceAttributes,
  validateOtelExporterHeaders,
} from "./sanitize.js";

describe("OTEL export hygiene (§8.2)", () => {
  const prevHeaders = process.env.OTEL_EXPORTER_OTLP_HEADERS;

  afterEach(() => {
    if (prevHeaders) process.env.OTEL_EXPORTER_OTLP_HEADERS = prevHeaders;
    else delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
  });

  it("strips Authorization and secret-shaped attrs", () => {
    const cleaned = stripSecretAttributes({
      "mcp.method": "tools/call",
      Authorization: "Bearer secret-token",
      api_key: "abc123",
      "mcp.tool": "echo",
    });
    expect(cleaned).toEqual({ "mcp.method": "tools/call", "mcp.tool": "echo" });
  });

  it("builds tenant-scoped resource attributes", () => {
    const attrs = buildTenantResourceAttributes({
      githubOrg: "zotoio",
      runId: "run-1",
    });
    expect(attrs["service.name"]).toBe("botz-mcp-swarm");
    expect(attrs["tenant.github_org"]).toBe("zotoio");
    expect(attrs["tenant.id"]).toBe("zotoio");
    expect(attrs["run.id"]).toBe("run-1");
  });

  it("rejects raw bearer in OTEL_EXPORTER_OTLP_HEADERS", () => {
    process.env.OTEL_EXPORTER_OTLP_HEADERS = "Authorization=Bearer not-allowed";
    const result = validateOtelExporterHeaders();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("raw_bearer_in_otlp_headers");
  });

  it("allows empty OTEL_EXPORTER_OTLP_HEADERS", () => {
    delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
    expect(validateOtelExporterHeaders().ok).toBe(true);
  });
});
