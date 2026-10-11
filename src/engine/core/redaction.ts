const SENSITIVE_KEYS = new Set([
  "authorization",
  "token",
  "access_token",
  "refresh_token",
  "api_key",
  "apikey",
  "secret",
  "password",
  "bearer",
  "cookie",
  "x-api-key",
]);

/** Secret-shaped names such as GITHUB_TOKEN, X-Auth-Token, db_password, clientSecret. */
const SENSITIVE_NAME = /authorization|cookie|secret|passw(?:or)?d|token|api[-_]?key|private[-_]?key|credential|bearer/i;

const SENSITIVE_PATTERNS = [
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/g,
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
];

export const REDACTED = "[REDACTED]";

function sensitiveKey(key: string, value: unknown): boolean {
  if (SENSITIVE_KEYS.has(key.toLowerCase())) return true;
  if (typeof value === "number" || typeof value === "boolean") return false;
  return SENSITIVE_NAME.test(key);
}

export function redactString(value: string): string {
  let result = value;
  for (const pattern of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, REDACTED);
  }
  return result;
}

export function redactValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (typeof value === "object") return redactObject(value as Record<string, unknown>);
  return value;
}

export function redactObject(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (sensitiveKey(key, val)) {
      result[key] = REDACTED;
    } else {
      result[key] = redactValue(val);
    }
  }
  return result;
}

export function redactHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(headers)) {
    result[key] = sensitiveKey(key, val) ? REDACTED : redactString(val);
  }
  return result;
}
