import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProject, setSuiteDispatch } from "../engine/store/project-store.js";

const mocks = vi.hoisted(() => ({
  startSuiteRun: vi.fn(async () => ({ ok: false as const, error: "stopped_by_test" })),
}));

vi.mock("../engine/core/project-run.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  startSuiteRun: mocks.startSuiteRun,
}));

const { runProjectSuite } = await import("./project-ops.js");

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("project suite run from the CLI", () => {
  it("always runs in-process, even when the suite is set to worker dispatch", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "swarm-cli-dispatch-"));
    dirs.push(dataDir);
    const project = await createProject(
      { server: { transport: "streamable-http", url: "http://127.0.0.1:9/mcp" } },
      { dataDir, introspect: async () => [{ name: "echo", schemaHash: "abc", writeLike: false }] },
    );
    await setSuiteDispatch(project.id, project.suites[0]!.id, "worker", { dataDir });
    await expect(runProjectSuite(project.id, undefined, () => {}, { dataDir })).rejects.toThrow("stopped_by_test");
    const args = mocks.startSuiteRun.mock.calls[0]![0] as { dispatch?: string; workerDispatch?: unknown };
    expect(args.dispatch).toBe("local");
    expect(args.workerDispatch).toBeUndefined();
  });
});
