import { win32 } from "node:path";
import { REDACTED, redactHeaders, redactString } from "./redaction.js";
import type { Target } from "../types/manifest.js";
import type { RunServer } from "../types/run.js";

/**
 * Where a run connected, without credentials or machine paths: an HTTP URL loses its userinfo, query,
 * and fragment; a stdio command and any absolute argument become their basename; secret-shaped flags
 * (`--api-key=…`, `--password …`) become `[REDACTED]`.
 */
export function serverEndpoint(target: Target): string {
  if (target.transport !== "stdio") return bareUrl(target.url);
  const parts = [target.command, ...(target.args ?? [])];
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const flag = /^--?([A-Za-z0-9_-]+)(?:=(.*))?$/.exec(part);
    if (flag && secretFlag(flag[1]!)) {
      if (flag[2] !== undefined) {
        out.push(quote(`${portableFlagName(part)}=${REDACTED}`));
      } else {
        out.push(quote(portable(part)));
        const next = parts[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          out.push(quote(REDACTED));
          i += 1;
        }
      }
      continue;
    }
    const pathSafe = portable(part);
    out.push(quote(redactString(pathSafe) === pathSafe ? pathSafe : REDACTED));
  }
  return out.join(" ");
}

/** True when a CLI flag name is secret-shaped (`api-key`, `token`, `password`, …). */
function secretFlag(name: string): boolean {
  return redactHeaders({ [name]: "x" })[name] !== "x";
}

/** Keep `--flag` (or `-f`) and basename any absolute path after `=` was already split off. */
function portableFlagName(part: string): string {
  const eq = part.indexOf("=");
  return eq > 0 ? portable(part.slice(0, eq)) : portable(part);
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
