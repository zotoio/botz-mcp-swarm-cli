import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getProject, loadProjectRun, safeStoreSegment } from "./project-store.js";
import { assertSafeStdioArgs } from "../core/target-resolve.js";

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

  it.each(["../../etc/passwd", "a/b", "..", "x\0y"])("rejects traversal run id %j", async (runId) => {
    dataDir = await mkdtemp(join(tmpdir(), "swarm-ps-"));
    await expect(loadProjectRun("p_0b6e4b3a-1f0e-4d7c-9a51-0f5a7f6b1c2d", runId, { dataDir })).rejects.toThrow(/invalid run id/);
  });

  it("validates stdio args", () => {
    expect(assertSafeStdioArgs(undefined)).toEqual([]);
    expect(assertSafeStdioArgs(["--port", "1"])).toEqual(["--port", "1"]);
    expect(() => assertSafeStdioArgs(["a\0b"])).toThrow();
    expect(() => assertSafeStdioArgs([1 as unknown as string])).toThrow();
    expect(() => assertSafeStdioArgs("--x" as unknown as string[])).toThrow();
  });
});
