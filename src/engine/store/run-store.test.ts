import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RunStore } from "./run-store.js";
import type { RunReport } from "../types/run.js";

function minimalReport(id: string): RunReport {
  return {
    id,
    manifestName: "test",
    manifestHash: "abc",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 1,
    verdict: "pass",
    failReasons: [],
    silentGreen: false,
    mode: "smoke",
    transport: "stdio",
    sessionMetrics: { transport: "stdio", started: 1, active: 0, failed: 0 },
    toolSeries: [],
    rpcSeries: [],
    scenarioOutcomes: [],
    quotas: { concurrencyUsed: 0, callCount: 0, maxPayloadBytesSeen: 0 },
  };
}

describe("run store", () => {
  let dir: string;
  let store: RunStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "swarm-runs-"));
    store = new RunStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("persists and lists runs", async () => {
    await store.save(minimalReport("r1"), { principal: "alice" });
    const runs = await store.list();
    expect(runs).toHaveLength(1);
    expect(runs[0].principal).toBe("alice");
  });
});
