import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getProject, safeStoreSegment } from "./project-store.js";

describe("project store path safety", () => {
  let dataDir: string | undefined;
  afterEach(async () => {
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  });

  it("accepts normal ids", () => {
    expect(safeStoreSegment("p_0b6e4b3a-1f0e-4d7c-9a51-0f5a7f6b1c2d")).toMatch(/^p_/);
    expect(safeStoreSegment("s_abc.v2")).toBe("s_abc.v2");
  });

  it.each(["..", "../x", "a/b", "a\\b", ".hidden", "", "x\0y", "a..b"])("rejects %j", (id) => {
    expect(() => safeStoreSegment(id)).toThrow();
  });

  it("treats traversal project ids as not found", async () => {
    dataDir = await mkdtemp(join(tmpdir(), "swarm-ps-"));
    await expect(getProject("../../etc", { dataDir })).resolves.toBeNull();
  });
});
