/** Validate allowlist host entries (targets and gateways). */
export function validateAllowlistHost(host: string): { ok: true; host: string } | { ok: false; reason: string } {
  const trimmed = host.trim().toLowerCase();
  if (!trimmed) return { ok: false, reason: "empty_host" };
  if (trimmed.includes("://") || trimmed.includes("/")) {
    return { ok: false, reason: "host_must_not_include_scheme_or_path" };
  }
  if (trimmed.includes("*") && trimmed !== "stdio") {
    if (!/^\*\.[a-z0-9.-]+$/.test(trimmed)) {
      return { ok: false, reason: "invalid_wildcard" };
    }
  }
  return { ok: true, host: trimmed };
}
