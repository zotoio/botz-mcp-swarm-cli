import type {
  ErrorClass,
  LatencyPercentiles,
  RpcSeries,
  ScenarioOutcome,
  ToolSeries,
} from "../types/run.js";

export interface CallObservation {
  method: string;
  toolName?: string;
  nodeId?: string;
  latencyMs: number;
  errorClass: ErrorClass;
  bytesIn: number;
  bytesOut: number;
  sessionReuse: boolean;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
}

export function summarizeLatencies(values: number[]): LatencyPercentiles {
  if (values.length === 0) {
    return { mean: 0, std: 0, p50: 0, p90: 0, p95: 0, p99: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.length > 1
    ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)
    : 0;
  return {
    mean,
    std: Math.sqrt(variance),
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
}

function computePercentiles(values: number[]): LatencyPercentiles {
  return summarizeLatencies(values);
}

export class MetricsCollector {
  private readonly observations: CallObservation[] = [];
  private readonly scenarioOutcomes: ScenarioOutcome[] = [];
  private sessionsStarted = 0;
  private sessionsActive = 0;
  private sessionsFailed = 0;

  recordSessionStart(): void {
    this.sessionsStarted++;
    this.sessionsActive++;
  }

  recordSessionEnd(success: boolean): void {
    this.sessionsActive = Math.max(0, this.sessionsActive - 1);
    if (!success) this.sessionsFailed++;
  }

  recordCall(obs: CallObservation): void {
    this.observations.push(obs);
  }

  getObservations(): CallObservation[] {
    return this.observations;
  }

  recordScenarioOutcome(outcome: ScenarioOutcome): void {
    this.scenarioOutcomes.push(outcome);
  }

  getScenarioOutcomes(): ScenarioOutcome[] {
    return [...this.scenarioOutcomes];
  }

  getSessionMetrics(transport: string) {
    return {
      transport: transport as "stdio" | "sse" | "streamable-http",
      started: this.sessionsStarted,
      active: this.sessionsActive,
      failed: this.sessionsFailed,
    };
  }

  buildToolSeries(): ToolSeries[] {
    const byTool = new Map<string, CallObservation[]>();
    for (const obs of this.observations) {
      if (obs.method !== "tools/call" || !obs.toolName) continue;
      const list = byTool.get(obs.toolName) ?? [];
      list.push(obs);
      byTool.set(obs.toolName, list);
    }

    return [...byTool.entries()].map(([toolName, obs]) => {
      const errors = obs.filter((o) => o.errorClass !== "none");
      const errorClass: Record<ErrorClass, number> = {
        none: 0,
        protocol: 0,
        application: 0,
        timeout: 0,
        transport: 0,
        quota: 0,
        allowlist: 0,
        auth: 0,
        rate_limit: 0,
      };
      for (const o of obs) {
        errorClass[o.errorClass]++;
      }
      return {
        toolName,
        count: obs.length,
        errorRate: obs.length > 0 ? errors.length / obs.length : 0,
        errorClass,
        latencyMs: computePercentiles(obs.map((o) => o.latencyMs)),
        bytesIn: obs.reduce((s, o) => s + o.bytesIn, 0),
        bytesOut: obs.reduce((s, o) => s + o.bytesOut, 0),
      };
    });
  }

  buildRpcSeries(): RpcSeries[] {
    const byMethod = new Map<string, CallObservation[]>();
    for (const obs of this.observations) {
      const list = byMethod.get(obs.method) ?? [];
      list.push(obs);
      byMethod.set(obs.method, list);
    }

    return [...byMethod.entries()].map(([method, obs]) => {
      const errors = obs.filter((o) => o.errorClass !== "none");
      return {
        method,
        count: obs.length,
        errorRate: obs.length > 0 ? errors.length / obs.length : 0,
        latencyMs: computePercentiles(obs.map((o) => o.latencyMs)),
      };
    });
  }
}

export function detectSilentGreen(
  scenarioCount: number,
  outcomes: ScenarioOutcome[],
  trafficIntended: boolean,
): boolean {
  if (!trafficIntended || scenarioCount === 0) return false;
  const meaningful = outcomes.filter(
    (o) => o.outcome === "pass" || o.outcome === "fail",
  );
  return meaningful.length === 0;
}

export function computeVerdict(
  failReasons: string[],
  silentGreen: boolean,
): "pass" | "fail" {
  if (silentGreen || failReasons.length > 0) return "fail";
  return "pass";
}
