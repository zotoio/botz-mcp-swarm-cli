import { readFile } from "node:fs/promises";

export interface ProcessSample {
  ts: string;
  pid: number;
  runtime: "node" | "python";
  role: "worker" | "sut";
  rssBytes: number;
  cpuRatio: number;
}

export interface ProcessSummary {
  pid: number;
  runtime: "node" | "python";
  role: "worker" | "sut";
  samples: number;
  rssBytes: { min: number; max: number; last: number };
  cpuRatio: { min: number; max: number; avg: number; last: number };
}

interface CpuSnapshot {
  utime: number;
  stime: number;
  at: number;
}

const CLK_TCK = 100;

function parseProcStat(statLine: string): { utime: number; stime: number } {
  const afterPid = statLine.slice(statLine.lastIndexOf(")") + 2);
  const parts = afterPid.split(" ");
  return {
    utime: Number.parseInt(parts[11] ?? "0", 10),
    stime: Number.parseInt(parts[12] ?? "0", 10),
  };
}

async function readRssBytes(pid: number): Promise<number> {
  try {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    const match = status.match(/VmRSS:\s+(\d+)\s+kB/);
    return match ? Number.parseInt(match[1], 10) * 1024 : 0;
  } catch {
    return 0;
  }
}

async function readCpuSnapshot(pid: number): Promise<CpuSnapshot | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const { utime, stime } = parseProcStat(stat);
    return { utime, stime, at: Date.now() };
  } catch {
    return null;
  }
}

function cpuRatioFromSnapshots(
  prev: CpuSnapshot,
  curr: CpuSnapshot,
): number {
  const elapsedSec = (curr.at - prev.at) / 1000;
  if (elapsedSec <= 0) return 0;
  const deltaTicks = curr.utime + curr.stime - (prev.utime + prev.stime);
  return deltaTicks / CLK_TCK / elapsedSec;
}

export class ProcessGaugeCollector {
  private readonly samples: ProcessSample[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private readonly cpuPrev = new Map<number, CpuSnapshot>();

  constructor(
    private readonly workerPid: number,
    private readonly sutPids: Set<number> = new Set(),
  ) {}

  trackSutPid(pid: number | null | undefined): void {
    if (pid && pid > 0) this.sutPids.add(pid);
  }

  async sampleOnce(): Promise<void> {
    const ts = new Date().toISOString();
    await this.samplePid(this.workerPid, "node", "worker", ts);
    for (const pid of this.sutPids) {
      await this.samplePid(pid, "node", "sut", ts);
    }
  }

  private async samplePid(
    pid: number,
    runtime: "node" | "python",
    role: "worker" | "sut",
    ts: string,
  ): Promise<void> {
    let rssBytes = 0;
    let cpuRatio = 0;

    if (pid === process.pid) {
      rssBytes = process.memoryUsage().rss;
      const curr = await readCpuSnapshot(pid);
      const prev = this.cpuPrev.get(pid);
      if (curr) {
        if (prev) cpuRatio = cpuRatioFromSnapshots(prev, curr);
        this.cpuPrev.set(pid, curr);
      }
    } else if (process.platform === "linux") {
      rssBytes = await readRssBytes(pid);
      const curr = await readCpuSnapshot(pid);
      const prev = this.cpuPrev.get(pid);
      if (curr) {
        if (prev) cpuRatio = cpuRatioFromSnapshots(prev, curr);
        this.cpuPrev.set(pid, curr);
      }
    }

    this.samples.push({ ts, pid, runtime, role, rssBytes, cpuRatio });
  }

  start(intervalMs: number): void {
    void this.sampleOnce();
    this.timer = setInterval(() => void this.sampleOnce(), intervalMs);
  }

  async stop(): Promise<ProcessSample[]> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.sampleOnce();
    return [...this.samples];
  }

  getSamples(): ProcessSample[] {
    return [...this.samples];
  }

  summarize(): { worker: ProcessSummary; sut: ProcessSummary | null } {
    const workerSamples = this.samples.filter((s) => s.role === "worker");
    const sutSamples = this.samples.filter((s) => s.role === "sut");
    return {
      worker: summarizeRole(workerSamples, "node", "worker"),
      sut: sutSamples.length > 0
        ? summarizeRole(sutSamples, "node", "sut")
        : null,
    };
  }
}

function summarizeRole(
  samples: ProcessSample[],
  runtime: "node" | "python",
  role: "worker" | "sut",
): ProcessSummary {
  if (samples.length === 0) {
    return {
      pid: 0,
      runtime,
      role,
      samples: 0,
      rssBytes: { min: 0, max: 0, last: 0 },
      cpuRatio: { min: 0, max: 0, avg: 0, last: 0 },
    };
  }
  const rss = samples.map((s) => s.rssBytes);
  const cpu = samples.map((s) => s.cpuRatio);
  return {
    pid: samples[samples.length - 1].pid,
    runtime,
    role,
    samples: samples.length,
    rssBytes: {
      min: Math.min(...rss),
      max: Math.max(...rss),
      last: rss[rss.length - 1],
    },
    cpuRatio: {
      min: Math.min(...cpu),
      max: Math.max(...cpu),
      avg: cpu.reduce((a, b) => a + b, 0) / cpu.length,
      last: cpu[cpu.length - 1],
    },
  };
}

export function checkProcessAssertions(
  summary: { worker: ProcessSummary; sut: ProcessSummary | null },
  assertions: {
    maxWorkerRssBytes?: number;
    maxSutRssBytes?: number;
    maxWorkerCpuRatio?: number;
    maxSutCpuRatio?: number;
  },
): string[] {
  const failures: string[] = [];
  if (
    assertions.maxWorkerRssBytes !== undefined &&
    summary.worker.rssBytes.max > assertions.maxWorkerRssBytes
  ) {
    failures.push(
      `Worker RSS max ${summary.worker.rssBytes.max} exceeds ${assertions.maxWorkerRssBytes}`,
    );
  }
  if (
    assertions.maxWorkerCpuRatio !== undefined &&
    summary.worker.cpuRatio.max > assertions.maxWorkerCpuRatio
  ) {
    failures.push(
      `Worker CPU max ${summary.worker.cpuRatio.max.toFixed(3)} exceeds ${assertions.maxWorkerCpuRatio}`,
    );
  }
  if (summary.sut) {
    if (
      assertions.maxSutRssBytes !== undefined &&
      summary.sut.rssBytes.max > assertions.maxSutRssBytes
    ) {
      failures.push(
        `SUT RSS max ${summary.sut.rssBytes.max} exceeds ${assertions.maxSutRssBytes}`,
      );
    }
    if (
      assertions.maxSutCpuRatio !== undefined &&
      summary.sut.cpuRatio.max > assertions.maxSutCpuRatio
    ) {
      failures.push(
        `SUT CPU max ${summary.sut.cpuRatio.max.toFixed(3)} exceeds ${assertions.maxSutCpuRatio}`,
      );
    }
  }
  return failures;
}
