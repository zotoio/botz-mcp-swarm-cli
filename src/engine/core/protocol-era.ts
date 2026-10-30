/** MCP protocol eras. Kept dependency-free so the suite generator can import it without cycles. */

/** First MCP revision of the sessionless "modern" era (`server/discover`, no `ping`/`logging/setLevel`). */
export const MODERN_PROTOCOL_REVISION = "2026-07-28";

/** JSON-RPC methods removed from the modern era. A generated suite must not call them there. */
export const MODERN_REMOVED_METHODS: ReadonlySet<string> = new Set(["ping", "logging/setLevel"]);

export type ProtocolEra = "modern" | "legacy" | "unknown";

/** Era from an explicit era, else from the negotiated protocol (date-stamped revisions sort lexically). */
export function protocolEraFor(protocolVersion?: string | null, era?: string | null): ProtocolEra {
  if (era === "modern" || era === "legacy") return era;
  const v = (protocolVersion ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return "unknown";
  return v >= MODERN_PROTOCOL_REVISION ? "modern" : "legacy";
}

export function isModernEra(protocolVersion?: string | null, era?: string | null): boolean {
  return protocolEraFor(protocolVersion, era) === "modern";
}
