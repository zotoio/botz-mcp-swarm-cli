import { describe, expect, it } from "vitest";
import { buildTimeline, formatLoadTimeline, LoadTimelineCollector, sparkline } from "./load-timeline.js";

describe("load timeline", () => {
  it("buckets VUs and TPS overall and per tool", () => {
    const t = buildTimeline(
      [{ t: 0, active: 1 }, { t: 1000, active: 4 }, { t: 2500, active: 2 }],
      [
        { tool: "a", start: 100, end: 400, ok: true },
        { tool: "a", start: 200, end: 900, ok: false },
        { tool: "b", start: 1100, end: 1200, ok: true },
        { tool: "a", start: 1500, end: 1600, ok: true },
        { tool: "a", start: 1500, end: 1700, ok: true },
        { tool: "a", start: 1550, end: 1650, ok: true },
      ],
      3000,
    );
    expect(t.points).toHaveLength(3);
    expect(t.points.map((p) => p.vus)).toEqual([1, 4, 4]);
    expect(t.points.map((p) => p.tps)).toEqual([2, 4, 0]);
    expect(t.points[0]!.errors).toBe(1);
    expect(t.points[1]!.tools.a).toEqual({ calls: 3, errors: 0, peakInFlight: 3 });
    expect(t.summary.overall).toMatchObject({ peakVus: 4, peakTps: 4, avgTps: 2, calls: 6, errors: 1 });
    // VU area: 1*1000 + 4*1500 + 2*500 = 8000 over 3000 ms
    expect(t.summary.overall.avgVus).toBe(2.67);
    expect(t.summary.tools.a).toMatchObject({ peakVus: 3, peakTps: 3, calls: 5, errors: 1 });
    expect(t.summary.tools.b).toMatchObject({ peakVus: 1, calls: 1 });
  });

  it("uses calls in flight as VUs when the run publishes no VU counts", () => {
    const t = buildTimeline([], [
      { tool: "a", start: 0, end: 500, ok: true },
      { tool: "b", start: 100, end: 600, ok: true },
    ], 1000);
    expect(t.points[0]!.vus).toBe(2);
    expect(t.summary.overall).toMatchObject({ peakVus: 2, avgVus: 1 });
  });

  it("collects from runner events", () => {
    const c = new LoadTimelineCollector(1000, 0);
    c.setVus(2, 0);
    c.recordToolCall("echo", 50, true, 500);
    c.recordToolCall("echo", 50, false, 1500);
    const t = c.finish(2000);
    expect(t.summary.overall).toMatchObject({ peakVus: 2, calls: 2, errors: 1, avgTps: 1 });
  });

  it("formats a sparkline and table", () => {
    expect(sparkline([0, 1, 2, 4])).toBe("▁▃▅█");
    expect(sparkline([0, 0])).toBe("▁▁");
    expect(sparkline(Array.from({ length: 100 }, (_, i) => i), 10)).toHaveLength(10);
    const lines = formatLoadTimeline(buildTimeline([{ t: 0, active: 2 }], [{ tool: "echo", start: 0, end: 10, ok: true }], 1000));
    expect(lines[0]).toContain("Load over 1s");
    expect(lines.some((l) => l.includes("peak VUs") && l.includes("avg TPS"))).toBe(true);
    expect(lines.some((l) => /^\s+echo\s+1/.test(l))).toBe(true);
  });
});
