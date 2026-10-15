function envSlug(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "VALUE";
}

/**
 * `${env:NAME}` name for a literal target credential: prefix plus the key upper-cased, non-alphanumeric runs as `_`.
 * A server other than the suite's default adds its alias: `SWARM_TARGET_JIRA_HEADER_AUTHORIZATION`.
 */
export function envRefName(source: "header" | "env", key: string, alias?: string): string {
  const server = alias ? `${envSlug(alias)}_` : "";
  return `SWARM_TARGET_${server}${source === "header" ? "HEADER" : "ENV"}_${envSlug(key)}`;
}

/** Prefix of every credential name `envRefName` makes for one server. */
export function envRefPrefix(alias?: string): string {
  return `SWARM_TARGET_${alias ? `${envSlug(alias)}_` : ""}`;
}

const EXACT_REF = /^(?:[A-Za-z]+ )?\$\{env:[A-Za-z_][A-Za-z0-9_]*\}$/;

/** True when the value is exactly `${env:NAME}` or `<scheme> ${env:NAME}`, so it holds no literal secret. */
export function isEnvReference(value: string): boolean {
  return EXACT_REF.test(value);
}
