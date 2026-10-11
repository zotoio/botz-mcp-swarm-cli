import type { Target } from "../types/manifest.js";

export class AllowlistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AllowlistError";
  }
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^\[|\]$/g, "");
}

export function extractTargetHosts(target: Target): string[] {
  if (target.transport === "stdio") {
    return ["stdio"];
  }
  const url = new URL(target.url);
  return [normalizeHost(url.hostname)];
}

export function isTargetAllowlisted(
  target: Target,
  allowlist: string[],
): boolean {
  const hosts = extractTargetHosts(target);
  const normalizedAllowlist = allowlist.map((entry) =>
    entry.toLowerCase().trim(),
  );

  return hosts.every((host) =>
    normalizedAllowlist.some((allowed) => {
      if (allowed === "stdio" && host === "stdio") return true;
      if (allowed === "localhost" && (host === "localhost" || host === "127.0.0.1")) {
        return true;
      }
      if (allowed.startsWith("*.")) {
        const suffix = allowed.slice(1);
        return host.endsWith(suffix) || host === allowed.slice(2);
      }
      return host === allowed;
    }),
  );
}

export function assertTargetAllowlisted(
  target: Target,
  allowlist: string[],
  gatewayId?: string,
): void {
  if (!isTargetAllowlisted(target, allowlist)) {
    const hosts = extractTargetHosts(target).join(", ");
    throw new AllowlistError(
      `Target host(s) [${hosts}] not in allowlist: [${allowlist.join(", ")}]`,
    );
  }
  if (gatewayId && !allowlist.includes(gatewayId) && !allowlist.some((a) => a.startsWith("*"))) {
    throw new AllowlistError(
      `Gateway id [${gatewayId}] not in allowlist: [${allowlist.join(", ")}]`,
    );
  }
}
