import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import https from "node:https";
import http from "node:http";

const PRIVATE_IPV4 = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^0\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT 100.64.0.0/10
];

export interface EgressUrlOptions {
  /** Require https (default true). */
  requireHttps?: boolean;
  /** Allow http only for loopback hosts when requireHttps is relaxed. */
  allowHttpLoopback?: boolean;
  /** Explicit hostname allowlist; when non-empty, hostname must match an entry. */
  hostAllowlist?: string[];
  /** Skip DNS resolution (unit tests only). */
  skipDns?: boolean;
  /** Injectable DNS resolver (unit tests). */
  dnsResolver?: DnsResolver;
}

export function isBlockedIpv4(address: string): boolean {
  return PRIVATE_IPV4.some((re) => re.test(address));
}

/** Eight 16-bit groups, or null when `address` is not a valid IPv6 literal. */
function ipv6Groups(address: string): number[] | null {
  let text = address.toLowerCase().replace(/%.*$/, "");
  if (isIP(text) !== 6) return null;
  const dotted = text.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.includes("::") ? text.split("::") : [text, undefined];
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const fill = tail === undefined ? [] : new Array(8 - left.length - right.length).fill("0");
  const groups = [...left, ...fill, ...right].map((g) => Number.parseInt(g, 16));
  return groups.length === 8 ? groups : null;
}

function embeddedIpv4(groups: number[]): string {
  const [hi, lo] = [groups[6] ?? 0, groups[7] ?? 0];
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/**
 * Block IPv6 unspecified and loopback plus deprecated IPv4-compatible (::/96), ULA
 * (fc00::/7), link-local (fe80::/10), site-local (fec0::/10), multicast (ff00::/8), and
 * IPv4-mapped (::ffff:0:0/96) or NAT64 (64:ff9b::/96) forms whose IPv4 is blocked.
 * Unparseable input fails closed.
 */
export function isBlockedIpv6(address: string): boolean {
  const groups = ipv6Groups(address);
  if (!groups) return true;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0] = groups;
  const firstFiveZero = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
  if (firstFiveZero && g5 === 0) return true;
  if (firstFiveZero && g5 === 0xffff) return isBlockedIpv4(embeddedIpv4(groups));
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isBlockedIpv4(embeddedIpv4(groups));
  }
  if ((g0 & 0xfe00) === 0xfc00) return true;
  if ((g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0) return true;
  if ((g0 & 0xff00) === 0xff00) return true;
  return false;
}

/** URL hostnames keep IPv6 literals in brackets; strip them for IP checks. */
function bareHost(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

export function isBlockedIp(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return isBlockedIpv4(address);
  if (kind === 6) return isBlockedIpv6(address);
  return true;
}

function hostnameAllowed(hostname: string, allowlist?: string[]): boolean {
  if (!allowlist || allowlist.length === 0) return true;
  const host = hostname.toLowerCase();
  return allowlist.some((entry) => entry.toLowerCase() === host);
}

export function validateEgressUrlSync(
  url: string,
  options: EgressUrlOptions = {},
): { ok: true; parsed: URL } | { ok: false; reason: string } {
  const trimmed = url.trim();
  if (!trimmed) return { ok: false, reason: "empty_url" };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }

  const host = parsed.hostname.toLowerCase();
  const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "::1";

  if (parsed.protocol === "https:") {
    // allowed
  } else if (parsed.protocol === "http:" && options.allowHttpLoopback && isLoopback) {
    // allowed for local OTLP collectors only
  } else {
    return { ok: false, reason: "https_required" };
  }

  if (!hostnameAllowed(host, options.hostAllowlist)) {
    return { ok: false, reason: "host_not_allowlisted" };
  }

  if (isLoopback && !options.allowHttpLoopback) {
    return { ok: false, reason: "loopback_not_allowed" };
  }

  if (host.endsWith(".local") || host.endsWith(".internal")) {
    return { ok: false, reason: "private_host" };
  }

  const ipHost = bareHost(host);
  const ipKind = isIP(ipHost);
  if (ipKind === 4 && isBlockedIpv4(ipHost)) return { ok: false, reason: "private_ip" };
  if (ipKind === 6 && isBlockedIpv6(ipHost)) return { ok: false, reason: "private_ip" };

  return { ok: true, parsed };
}

export type DnsResolver = (hostname: string) => Promise<string[]>;

async function defaultDnsResolver(hostname: string): Promise<string[]> {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => r.address);
}

export async function resolveHostAddresses(
  hostname: string,
  resolver?: DnsResolver,
): Promise<string[]> {
  const literal = bareHost(hostname);
  if (isIP(literal)) return [literal];
  const resolve = resolver ?? defaultDnsResolver;
  return resolve(hostname);
}

export async function validateEgressUrl(
  url: string,
  options: EgressUrlOptions = {},
): Promise<
  | { ok: true; parsed: URL; resolvedAddresses: string[] }
  | { ok: false; reason: string }
> {
  const sync = validateEgressUrlSync(url, options);
  if (!sync.ok) return sync;

  if (options.skipDns) {
    return { ok: true, parsed: sync.parsed, resolvedAddresses: [] };
  }

  try {
    const addresses = await resolveHostAddresses(sync.parsed.hostname, options.dnsResolver);
    if (addresses.length === 0) return { ok: false, reason: "dns_no_records" };
    const loopbackHost =
      sync.parsed.hostname.toLowerCase() === "localhost" ||
      sync.parsed.hostname === "127.0.0.1" ||
      sync.parsed.hostname === "::1";
    for (const address of addresses) {
      if (!isBlockedIp(address)) continue;
      if (
        options.allowHttpLoopback &&
        loopbackHost &&
        (address === "127.0.0.1" || address === "::1")
      ) {
        continue;
      }
      return { ok: false, reason: "private_ip" };
    }
    return { ok: true, parsed: sync.parsed, resolvedAddresses: addresses };
  } catch {
    return { ok: false, reason: "dns_resolve_failed" };
  }
}

export function egressHostname(url: string): string | null {
  try {
    return new URL(url.trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function addHostToEgressAllowlist(
  allowlist: string[],
  url: string,
): string[] {
  const host = egressHostname(url);
  if (!host) return allowlist;
  if (allowlist.some((h) => h.toLowerCase() === host)) return allowlist;
  return [...allowlist, host];
}

/** DNS-resolve-then-connect: uses resolved IP with SNI Host header (mitigate rebinding). */
export async function safeEgressRequest(
  urlString: string,
  init: {
    method: string;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  },
  options: EgressUrlOptions = {},
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const validated = await validateEgressUrl(urlString, options);
  if (!validated.ok) return { ok: false, error: validated.reason };

  const parsed = validated.parsed;
  const addresses = validated.resolvedAddresses.length
    ? validated.resolvedAddresses
    : await resolveHostAddresses(parsed.hostname, options.dnsResolver);
  if (!addresses.length) return { ok: false, error: "dns_no_records" };

  const targetIp = addresses[0];
  const isHttps = parsed.protocol === "https:";
  const port = parsed.port ? Number.parseInt(parsed.port, 10) : isHttps ? 443 : 80;
  const path = `${parsed.pathname}${parsed.search}`;
  const timeoutMs = init.timeoutMs ?? 5000;

  return new Promise((resolve) => {
    const requestFn = isHttps ? https.request : http.request;
    const req = requestFn(
      {
        host: targetIp,
        port,
        path,
        method: init.method,
        headers: {
          Host: parsed.hostname,
          ...init.headers,
        },
        servername: isHttps ? parsed.hostname : undefined,
        timeout: timeoutMs,
      },
      (res) => {
        res.resume();
        resolve({ ok: (res.statusCode ?? 500) >= 200 && (res.statusCode ?? 500) < 300, status: res.statusCode });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, error: "timeout" });
    });
    req.on("error", (err) => resolve({ ok: false, error: err.message }));
    if (init.body) req.write(init.body);
    req.end();
  });
}

/**
 * SWARM-06/SWARM-17: wrap fetch so every outbound OAuth request (server URL, discovered metadata,
 * user-supplied endpoints, DCR, token and refresh) is https-only and never targets private,
 * loopback, link-local, or cloud-metadata addresses (checked after DNS resolution). Redirects are
 * not followed.
 */
export function egressGuardedFetch(inner: typeof fetch = fetch, options: EgressUrlOptions = {}): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const target = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const checked = await validateEgressUrl(target, { ...options, requireHttps: true, allowHttpLoopback: false });
    if (!checked.ok) throw new Error(`oauth_egress_blocked:${checked.reason}`);
    return inner(input, { ...init, redirect: "error" });
  }) as typeof fetch;
}
