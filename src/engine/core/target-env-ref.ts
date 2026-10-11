/** `${env:NAME}` name for a literal target credential: prefix plus the key upper-cased, non-alphanumeric runs as `_`. */
export function envRefName(source: "header" | "env", key: string): string {
  const slug = key.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "VALUE";
  return `SWARM_TARGET_${source === "header" ? "HEADER" : "ENV"}_${slug}`;
}

const EXACT_REF = /^(?:[A-Za-z]+ )?\$\{env:[A-Za-z_][A-Za-z0-9_]*\}$/;

/** True when the value is exactly `${env:NAME}` or `<scheme> ${env:NAME}`, so it holds no literal secret. */
export function isEnvReference(value: string): boolean {
  return EXACT_REF.test(value);
}
