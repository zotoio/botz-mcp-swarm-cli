import { describe, it, expect } from "vitest";
import {
  ProcessGaugeCollector,
  checkProcessAssertions,
} from "@zotoio/botz-mcp-swarm-engine/core/process-gauges.js";

describe("process gauges", () => {
  it("collects worker samples", async () => {
    const collector = new ProcessGaugeCollector(process.pid);
    collector.start(50);
    await new Promise((r) => setTimeout(r, 120));
    const samples = await collector.stop();
    expect(samples.length).toBeGreaterThan(0);
    expect(samples[0].role).toBe("worker");
    expect(samples[0].rssBytes).toBeGreaterThan(0);
  });

  it("checks process assertion failures", () => {
    const summary = {
      worker: {
        pid: 1,
        runtime: "node" as const,
        role: "worker" as const,
        samples: 2,
        rssBytes: { min: 1000, max: 2000000000, last: 1000 },
        cpuRatio: { min: 0, max: 0.1, avg: 0.05, last: 0.1 },
      },
      sut: null,
    };
    const failures = checkProcessAssertions(summary, {
      maxWorkerRssBytes: 1_000_000,
    });
    expect(failures.length).toBe(1);
    expect(failures[0]).toContain("Worker RSS");
  });

  it("asserts every SUT alias when secondary servers are present", () => {
    const empty = {
      pid: 1,
      runtime: "node" as const,
      role: "sut" as const,
      samples: 1,
      rssBytes: { min: 100, max: 100, last: 100 },
      cpuRatio: { min: 0, max: 0.01, avg: 0.01, last: 0.01 },
    };
    const heavy = { ...empty, rssBytes: { min: 100, max: 9_000_000, last: 9_000_000 } };
    const failures = checkProcessAssertions({
      worker: { ...empty, role: "worker" },
      sut: empty,
      suts: { default: empty, other: heavy },
    }, { maxSutRssBytes: 1_000_000 });
    expect(failures).toEqual(["SUT other RSS max 9000000 exceeds 1000000"]);
  });
});
