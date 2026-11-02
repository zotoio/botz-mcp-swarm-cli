/**
 * Per-service master keys for Swarm data at rest (security D3/D6, 2026-10-29).
 *
 * SWARM_STORAGE_KEYS        "<kid>:<base64url 32-byte key>,..." — first entry is ACTIVE for writes,
 *                           every entry is accepted for reads (rotation: prepend, restart, `rekey`).
 * SWARM_STORAGE_HASH_PEPPER base64url >=32-byte HMAC-SHA256 pepper for hashing OAuth codes,
 *                           refresh tokens and pending OAuth states.
 * Production loads both from the root-only 0400 file /etc/botz/keys/swarm.env (compose env_file).
 *
 * File envelope: {"__swarm_enc":1,"kid":"<kid>","data":"<base64url nonce|ct|tag>"} — AES-256-GCM,
 * AAD = "swarm:" + purpose. Readers accept legacy plaintext JSON; writers are atomic (tmp + rename, 0600).
 * Never logs keys or values.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, basename, join } from "node:path";

export class KeyringError extends Error {}

function b64d(s: string): Buffer {
  return Buffer.from(s.trim(), "base64url");
}

export function generateKey(): string {
  return randomBytes(32).toString("base64url");
}

export interface SealedEnvelope {
  __swarm_enc: 1;
  kid: string;
  data: string;
}

export class Keyring {
  readonly activeKid: string;
  private readonly keys = new Map<string, Buffer>();
  private readonly pepper: Buffer | null;

  constructor(entries: Array<[string, Buffer]>, pepper: Buffer | null = null) {
    if (entries.length === 0) throw new KeyringError("keyring needs at least one key");
    for (const [kid, key] of entries) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(kid)) throw new KeyringError("invalid key id");
      if (key.length !== 32) throw new KeyringError(`key ${kid} must be 32 bytes (AES-256)`);
      if (this.keys.has(kid)) throw new KeyringError(`duplicate key id ${kid}`);
      this.keys.set(kid, key);
    }
    this.activeKid = entries[0]![0];
    this.pepper = pepper;
  }

  static parse(spec: string, pepper = ""): Keyring {
    const entries: Array<[string, Buffer]> = [];
    for (const part of spec.split(",").map((p) => p.trim()).filter(Boolean)) {
      const i = part.indexOf(":");
      if (i <= 0) throw new KeyringError("SWARM_STORAGE_KEYS entries must be <kid>:<base64url key>");
      entries.push([part.slice(0, i), b64d(part.slice(i + 1))]);
    }
    let pep: Buffer | null = null;
    if (pepper.trim()) {
      pep = b64d(pepper);
      if (pep.length < 32) throw new KeyringError("SWARM_STORAGE_HASH_PEPPER must be >= 32 bytes");
    }
    return new Keyring(entries, pep);
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): Keyring | null {
    const spec = env.SWARM_STORAGE_KEYS?.trim();
    if (!spec) return null;
    return Keyring.parse(spec, env.SWARM_STORAGE_HASH_PEPPER ?? "");
  }

  get kids(): string[] {
    return [...this.keys.keys()];
  }

  get hasPepper(): boolean {
    return this.pepper !== null;
  }

  seal(plaintext: Buffer, purpose: string): SealedEnvelope {
    const nonce = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.keys.get(this.activeKid)!, nonce);
    c.setAAD(Buffer.from(`swarm:${purpose}`));
    const ct = Buffer.concat([c.update(plaintext), c.final()]);
    return { __swarm_enc: 1, kid: this.activeKid, data: Buffer.concat([nonce, ct, c.getAuthTag()]).toString("base64url") };
  }

  open(env: SealedEnvelope, purpose: string): Buffer {
    const key = this.keys.get(env.kid);
    if (!key) throw new KeyringError(`unknown key id ${env.kid}`);
    const blob = b64d(env.data);
    if (blob.length < 28) throw new KeyringError("ciphertext too short");
    const d = createDecipheriv("aes-256-gcm", key, blob.subarray(0, 12));
    d.setAAD(Buffer.from(`swarm:${purpose}`));
    d.setAuthTag(blob.subarray(blob.length - 16));
    return Buffer.concat([d.update(blob.subarray(12, blob.length - 16)), d.final()]);
  }

  /** HMAC-SHA256(pepper, purpose|value) hex; SHA-256 when no pepper is configured. */
  hashSecret(value: string, purpose: string): string {
    const msg = `${purpose}\u0000${value}`;
    if (!this.pepper) return `s256_${createHash("sha256").update(msg).digest("hex")}`;
    return `h256_${createHmac("sha256", this.pepper).update(msg).digest("hex")}`;
  }
}

/** Hash a lookup secret with the env keyring (SHA-256 fallback when no keyring is set). */
export function hashLookupSecret(value: string, purpose: string, keyring: Keyring | null = currentKeyring()): string {
  if (keyring) return keyring.hashSecret(value, purpose);
  return `s256_${createHash("sha256").update(`${purpose}\u0000${value}`).digest("hex")}`;
}

export function isSealedEnvelope(v: unknown): v is SealedEnvelope {
  return Boolean(v && typeof v === "object" && (v as SealedEnvelope).__swarm_enc === 1 && typeof (v as SealedEnvelope).kid === "string" && typeof (v as SealedEnvelope).data === "string");
}

let cached: { spec: string; pepper: string; kr: Keyring | null } | null = null;
/** Keyring from the current environment (re-parsed when the env changes; tests swap env). */
export function currentKeyring(): Keyring | null {
  const spec = process.env.SWARM_STORAGE_KEYS?.trim() ?? "";
  const pepper = process.env.SWARM_STORAGE_HASH_PEPPER ?? "";
  if (!cached || cached.spec !== spec || cached.pepper !== pepper) {
    cached = { spec, pepper, kr: spec ? Keyring.parse(spec, pepper) : null };
  }
  return cached.kr;
}

/** Parse a data file that may be sealed (envelope) or legacy plaintext JSON. */
export function decodeSealedJson<T>(raw: string, purpose: string, keyring: Keyring | null = currentKeyring()): T {
  const parsed = JSON.parse(raw) as unknown;
  if (!isSealedEnvelope(parsed)) return parsed as T;
  if (!keyring) throw new KeyringError("data file is encrypted but SWARM_STORAGE_KEYS is not set");
  return JSON.parse(keyring.open(parsed, purpose).toString("utf8")) as T;
}

export function encodeSealedJson(value: unknown, purpose: string, keyring: Keyring | null = currentKeyring(), pretty = false): string {
  const json = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  if (!keyring) return json;
  return JSON.stringify(keyring.seal(Buffer.from(json, "utf8"), purpose));
}

export async function readSealedJson<T>(path: string, purpose: string, keyring: Keyring | null = currentKeyring()): Promise<T> {
  return decodeSealedJson<T>(await readFile(path, "utf8"), purpose, keyring);
}

/** Atomic write: tmp file (0600) in the same directory, then rename over the target. */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  await writeFile(tmp, data, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
}

export async function writeSealedJson(path: string, value: unknown, purpose: string, keyring: Keyring | null = currentKeyring()): Promise<void> {
  await writeFileAtomic(path, encodeSealedJson(value, purpose, keyring));
}

/** Key id of a sealed file ("plaintext" for legacy files) — for status / rotation reports. */
export function sealedKidOf(raw: string): string {
  try {
    const p = JSON.parse(raw) as unknown;
    return isSealedEnvelope(p) ? p.kid : "plaintext";
  } catch {
    return "unparseable";
  }
}

/** Field names whose string values are credentials (MCP target auth / outbound OAuth). */
export const SECRET_FIELD_NAMES = new Set(["apiKey", "clientSecret", "accessToken", "refreshToken"]);
export const FIELD_PREFIX = "enc:v1:";

export function isSealedField(v: unknown): v is string {
  return typeof v === "string" && v.startsWith(FIELD_PREFIX);
}

/** Field-level seal: "enc:v1:<kid>:<base64url nonce|ct|tag>", AAD binds the field name. */
export function sealField(value: string, field: string, keyring: Keyring): string {
  const env = keyring.seal(Buffer.from(value, "utf8"), `field:${field}`);
  return `${FIELD_PREFIX}${env.kid}:${env.data}`;
}

export function openField(value: string, field: string, keyring: Keyring | null): string {
  if (!isSealedField(value)) return value; // legacy plaintext
  if (!keyring) throw new KeyringError("encrypted field but SWARM_STORAGE_KEYS is not set");
  const rest = value.slice(FIELD_PREFIX.length);
  const i = rest.indexOf(":");
  return keyring.open({ __swarm_enc: 1, kid: rest.slice(0, i), data: rest.slice(i + 1) }, `field:${field}`).toString("utf8");
}

function mapSecretFields(value: unknown, fn: (v: string, field: string) => string): unknown {
  if (Array.isArray(value)) return value.map((v) => mapSecretFields(v, fn));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_FIELD_NAMES.has(k) && typeof v === "string" && v ? fn(v, k) : mapSecretFields(v, fn);
    }
    return out;
  }
  return value;
}

/** Deep copy with every secret-named string field sealed (no-op without a keyring). */
export function sealSecretFields<T>(value: T, keyring: Keyring | null = currentKeyring()): T {
  if (!keyring) return value;
  return mapSecretFields(value, (v, f) => (isSealedField(v) ? v : sealField(v, f, keyring))) as T;
}

/** Deep copy with sealed fields decrypted; legacy plaintext passes through. */
export function openSecretFields<T>(value: T, keyring: Keyring | null = currentKeyring()): T {
  return mapSecretFields(value, (v, f) => openField(v, f, keyring)) as T;
}

/** Key id of every sealed field ("plaintext" for unsealed secret fields) — for status reports. */
export function secretFieldKids(value: unknown): string[] {
  const kids: string[] = [];
  mapSecretFields(value, (v) => {
    kids.push(isSealedField(v) ? v.slice(FIELD_PREFIX.length).split(":")[0]! : "plaintext");
    return v;
  });
  return kids;
}
