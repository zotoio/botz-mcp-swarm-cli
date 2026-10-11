const SECRET_KEY = /authorization|token|secret|password|api[_-]?key|bearer|credential/i;
const BEARER_VALUE = /^bearer\s+/i;

/** Strip Authorization and secret-shaped span/resource attributes before OTLP export. */
export function stripSecretAttributes(
  attrs: Record<string, unknown>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (SECRET_KEY.test(key)) continue;
    if (typeof value === "string" && BEARER_VALUE.test(value)) continue;
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      out[key] = value;
    }
  }
  return out;
}

export function buildTenantResourceAttributes(opts: {
  githubOrg: string;
  runId?: string;
  tenantId?: string;
}): Record<string, string> {
  const tenantId = opts.tenantId ?? opts.githubOrg;
  const attrs: Record<string, string> = {
    "service.name": "botz-mcp-swarm",
    "tenant.id": tenantId,
    "tenant.github_org": opts.githubOrg,
  };
  if (opts.runId) attrs["run.id"] = opts.runId;
  return attrs;
}

/**
 * Constrain OTEL_EXPORTER_OTLP_HEADERS — reject raw bearer tokens in shared envs.
 * Returns ok:false when headers look like they carry secrets inline.
 */
export function validateOtelExporterHeaders(): { ok: true } | { ok: false; reason: string } {
  const raw = process.env.OTEL_EXPORTER_OTLP_HEADERS?.trim();
  if (!raw) return { ok: true };

  const lower = raw.toLowerCase();
  if (lower.includes("bearer ") || lower.includes("authorization=")) {
    return { ok: false, reason: "raw_bearer_in_otlp_headers" };
  }

  for (const part of raw.split(",")) {
    const [key, ...rest] = part.split("=");
    const value = rest.join("=").trim();
    if (key && SECRET_KEY.test(key.trim()) && BEARER_VALUE.test(value)) {
      return { ok: false, reason: "raw_bearer_in_otlp_headers" };
    }
  }

  return { ok: true };
}
