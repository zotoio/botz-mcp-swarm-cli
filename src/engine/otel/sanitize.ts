const SECRET_KEY = /authorization|token|secret|password|api[_-]?key|bearer|credential/i;
const BEARER_VALUE = /^bearer\s+/i;
/** GenAI usage counters (e.g. gen_ai.usage.input_tokens) are safe numbers, not credentials. */
const USAGE_COUNTER_KEY = /^(gen_ai|llm)\.usage\.[a-z0-9_.]*tokens?$/i;

/** True for a secret-shaped attribute key, except numeric GenAI token-usage counters. */
export function isSecretAttributeKey(key: string, value?: unknown): boolean {
  if (!SECRET_KEY.test(key)) return false;
  if (USAGE_COUNTER_KEY.test(key) && value !== undefined && value !== "" && Number.isFinite(Number(value))) return false;
  return true;
}

/** Strip Authorization and secret-shaped span/resource attributes before OTLP export. */
export function stripSecretAttributes(
  attrs: Record<string, unknown>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (isSecretAttributeKey(key, value)) continue;
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
  projectId?: string;
  projectName?: string;
  suiteId?: string;
  suiteName?: string;
  suiteVersion?: number;
  basedOnVersion?: number;
  environment?: string;
  targetHostname?: string;
  targetUrl?: string;
  serverOverride?: boolean;
  inputFingerprint?: string;
  seedVariables?: Record<string, string>;
}): Record<string, string> {
  const tenantId = opts.tenantId ?? opts.githubOrg;
  const attrs: Record<string, string> = {
    "service.name": "botz-mcp-swarm",
    "tenant.id": tenantId,
    "tenant.github_org": opts.githubOrg,
  };
  if (opts.runId) attrs["run.id"] = opts.runId;
  if (opts.projectId) attrs["swarm.project.id"] = opts.projectId;
  if (opts.projectName) attrs["swarm.project.name"] = opts.projectName;
  if (opts.suiteId) attrs["swarm.suite.id"] = opts.suiteId;
  if (opts.suiteName) attrs["swarm.suite.name"] = opts.suiteName;
  if (opts.suiteVersion !== undefined) attrs["swarm.suite.version"] = String(opts.suiteVersion);
  if (opts.basedOnVersion !== undefined) attrs["swarm.suite.based_on_version"] = String(opts.basedOnVersion);
  if (opts.environment) attrs["swarm.runtime.environment"] = opts.environment;
  if (opts.targetHostname) attrs["swarm.runtime.target_hostname"] = opts.targetHostname;
  if (opts.targetUrl) attrs["swarm.runtime.target_url"] = opts.targetUrl;
  if (opts.serverOverride !== undefined) attrs["swarm.runtime.server_override"] = String(opts.serverOverride);
  if (opts.inputFingerprint) attrs["swarm.runtime.input_fingerprint"] = opts.inputFingerprint;
  if (opts.seedVariables && Object.keys(opts.seedVariables).length > 0) {
    const safeSeeds = stripSecretAttributes(opts.seedVariables);
    const keys = Object.keys(safeSeeds).sort();
    if (keys.length > 0) {
      attrs["swarm.runtime.seed_keys"] = keys.join(",");
      for (const k of keys) {
        attrs[`swarm.runtime.seed.${k}`] = String(safeSeeds[k]);
      }
    }
  }
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
