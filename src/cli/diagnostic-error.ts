import { ZodError } from "zod";

/** Report structure and reference names, never rejected values or raw JSON parser excerpts. */
export function diagnosticError(error: unknown): { code: string; detail: string; issues?: Array<{ path: string; code: string }> } {
  if (error instanceof ZodError) {
    const issues = error.issues.map((issue) => ({ path: issue.path.join(".") || "suite", code: issue.code }));
    return { code: "INVALID_SCHEMA", detail: issues.map((issue) => `${issue.path}: ${issue.code}`).join("; "), issues };
  }
  if (error instanceof SyntaxError) return { code: "INVALID_JSON", detail: "Invalid JSON; check syntax in the suite, target, or parameter file." };
  const message = error instanceof Error ? error.message : "";
  if (/^[a-z-]+ must be an integer >= [01]$/.test(message)) return { code: "INVALID_OPTION", detail: message };
  if (/^(provide exactly one of --suite or --manifest|provide --url or --target-file, not both|provide --duration-ms or --soak-duration-ms, not both|--url requires an HTTP suite; use --target-file to change transport)$/.test(message)) return { code: "INVALID_OPTION", detail: message };
  const missing = /^(missing credential|missing parameter|unknown parameter): ([A-Za-z0-9_, ]+)$/.exec(message);
  if (missing) return { code: missing[1]!.toUpperCase().replace(/ /g, "_"), detail: message };
  if (message === "suite_has_no_enabled_steps") return { code: "NO_ENABLED_STEPS", detail: "Enable at least one executable suite node." };
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT" || code === "EACCES") return { code, detail: code === "ENOENT" ? "Required suite, target, or parameter file was not found." : "Permission denied reading suite configuration." };
  if (message === "unsupported suite schemaVersion; upgrade the CLI") return { code: "UNSUPPORTED_VERSION", detail: message };
  return { code: "INVALID_CONFIGURATION", detail: "Check target credentials, parameters, and suite configuration." };
}
