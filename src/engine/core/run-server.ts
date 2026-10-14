import { win32 } from "node:path";
import type { Target } from "../types/manifest.js";
import type { RunServer } from "../types/run.js";

/**
 * Where a run connected, without credentials or machine paths: an HTTP URL loses its userinfo, query,
 * and fragment; a stdio command and any absolute argument become their basename.
 */
export function serverEndpoint(target: Target): string {
  if (target.transport !== "stdio") return bareUrl(target.url);
  return [target.command, ...(target.args ?? [])].map((part) => quote(portable(part))).join(" ");
}

export function runServer(target: Target, info?: { name?: string; version?: string }): RunServer {
  return {
    ...(info?.name ? { name: info.name } : {}),
    ...(info?.version ? { version: info.version } : {}),
    transport: target.transport,
    endpoint: serverEndpoint(target),
  };
}

/** `name version · transport endpoint`, with `unknown` for a missing name. */
export function formatRunServer(server: RunServer): string {
  const label = [server.name ?? "unknown", server.version].filter(Boolean).join(" ");
  return `${label} · ${server.transport} ${server.endpoint}`;
}

function bareUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return url.replace(/^([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/@?#]*@/, "$1").replace(/[?#].*$/, "");
  }
}

/** An absolute path, alone or as a `--flag=` value, becomes its basename. */
function portable(part: string): string {
  const eq = part.startsWith("-") ? part.indexOf("=") : -1;
  if (eq > 0) return `${part.slice(0, eq + 1)}${portable(part.slice(eq + 1))}`;
  return win32.isAbsolute(part) ? win32.basename(part) : part;
}

function quote(part: string): string {
  return part === "" || /\s|"/.test(part) ? JSON.stringify(part) : part;
}
