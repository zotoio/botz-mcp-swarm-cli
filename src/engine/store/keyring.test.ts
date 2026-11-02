import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeSealedJson, generateKey, Keyring, KeyringError, readSealedJson, writeSealedJson } from "./keyring.js";

describe("swarm keyring (AES-256-GCM, versioned kids)", () => {
  it("seals, opens with the matching purpose only, and rotates", () => {
    const k1 = generateKey();
    const a = Keyring.parse(`k1:${k1}`);
    const env = a.seal(Buffer.from("secret"), "p");
    expect(env.kid).toBe("k1");
    expect(JSON.stringify(env)).not.toContain("secret");
    expect(a.open(env, "p").toString()).toBe("secret");
    expect(() => a.open(env, "other")).toThrow();
    const b = Keyring.parse(`k2:${generateKey()},k1:${k1}`);
    expect(b.open(env, "p").toString()).toBe("secret");
    expect(b.seal(Buffer.from("x"), "p").kid).toBe("k2");
    expect(() => Keyring.parse(`k3:${generateKey()}`).open(env, "p")).toThrow(KeyringError);
  });

  it("rejects bad specs and reads legacy plaintext", async () => {
    for (const bad of ["nokid", "k1:abc", `k1:${generateKey()},k1:${generateKey()}`]) expect(() => Keyring.parse(bad)).toThrow(KeyringError);
    expect(Keyring.fromEnv({})).toBeNull();
    expect(decodeSealedJson('{"a":1}', "p", Keyring.parse(`k1:${generateKey()}`))).toEqual({ a: 1 });
    const d = mkdtempSync(join(tmpdir(), "kr-"));
    const kr = Keyring.parse(`k1:${generateKey()}`);
    await writeSealedJson(join(d, "f.json"), { tok: "gho_x" }, "p", kr);
    expect(readFileSync(join(d, "f.json"), "utf8")).not.toContain("gho_x");
    expect(await readSealedJson(join(d, "f.json"), "p", kr)).toEqual({ tok: "gho_x" });
    writeFileSync(join(d, "g.json"), JSON.stringify(kr.seal(Buffer.from("{}"), "p")));
    await expect(readSealedJson(join(d, "g.json"), "p", null)).rejects.toThrow(KeyringError);
  });

  it("peppered hashes differ per pepper", () => {
    const a = Keyring.parse(`k1:${generateKey()}`, generateKey());
    expect(a.hashSecret("v", "p")).toMatch(/^h256_[0-9a-f]{64}$/);
    expect(Keyring.parse(`k1:${generateKey()}`).hashSecret("v", "p")).toMatch(/^s256_/);
  });
});
