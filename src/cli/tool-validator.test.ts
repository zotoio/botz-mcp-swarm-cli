import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadToolResultValidator } from "./tool-validator.js";

describe("loadToolResultValidator", () => {
  it("rejects modules without validate export", async () => {
    const dir = mkdtempSync(join(tmpdir(), "validator-"));
    const mod = join(dir, "bad.mjs");
    writeFileSync(mod, "export const ok = true;\n");
    await expect(loadToolResultValidator("bad.mjs", dir)).rejects.toThrow(/must export validate/);
  });

  it("loads validate and forwards results", async () => {
    const dir = mkdtempSync(join(tmpdir(), "validator-"));
    const mod = join(dir, "check.mjs");
    writeFileSync(
      mod,
      `export function validate(ctx) {
  if (ctx.tool === "boom") return "nope";
  return null;
}
`,
    );
    const validator = await loadToolResultValidator("check.mjs", dir);
    expect(await validator({ tool: "ok", method: "tools/call", result: { success: true, errorClass: "none", latencyMs: 1, bytesIn: 0, bytesOut: 0 } })).toBeNull();
    expect(await validator({ tool: "boom", method: "tools/call", result: { success: true, errorClass: "none", latencyMs: 1, bytesIn: 0, bytesOut: 0 } })).toBe("nope");
  });
});
