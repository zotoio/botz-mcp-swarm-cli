import type {
  ErrorClass,
  FlowMetrics,
  LatencyPercentiles,
  RpcSeries,
  ScenarioOutcome,
  ToolSeries,
  VariableSummary,
} from "../types/run.js";

export interface CallObservation {
  /** Alias of the server the call went to. Absent means the default server. */
  server?: string;
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

interface SessionCounts {
  started: number;
  active: number;
  failed: number;
}

interface PassRecord {
  durationMs: number;
  outcome: "pass" | "fail" | "error";
  skipped: boolean;
}

export class MetricsCollector {
  private readonly observations: CallObservation[] = [];
  private readonly scenarioOutcomes: ScenarioOutcome[] = [];
  private sessionsStarted = 0;
  private sessionsActive = 0;
  private sessionsFailed = 0;
  private readonly sessionsByServer = new Map<string, SessionCounts>();
  private readonly passes: PassRecord[] = [];
  private readonly variables = new Map<string, VariableSummary>();

  constructor(private readonly multiServer = false) {}

  private serverCounts(server: string): SessionCounts {
    let counts = this.sessionsByServer.get(server);
    if (!counts) {
      counts = { started: 0, active: 0, failed: 0 };
      this.sessionsByServer.set(server, counts);
    }
    return counts;
  }

  recordSessionStart(server = ""): void {
    this.sessionsStarted++;
    this.sessionsActive++;
    const counts = this.serverCounts(server);
    counts.started++;
    counts.active++;
  }

  recordSessionEnd(success: boolean, server = ""): void {
    this.sessionsActive = Math.max(0, this.sessionsActive - 1);
    if (!success) this.sessionsFailed++;
    const counts = this.serverCounts(server);
    counts.active = Math.max(0, counts.active - 1);
    if (!success) counts.failed++;
  }

  /** Session counts for one server alias; the default server is recorded under "". */
  getServerSessions(server: string): SessionCounts {
    return { ...(this.sessionsByServer.get(server) ?? { started: 0, active: 0, failed: 0 }) };
  }

  /** One full pass of a scenario by one virtual user, from its first step to its last. */
  recordPass(pass: PassRecord): void {
    this.passes.push(pass);
  }

  buildFlow(): FlowMetrics {
    return {
      passes: this.passes.length,
      passesFailed: this.passes.filter((pass) => pass.outcome !== "pass").length,
      passesSkipped: this.passes.filter((pass) => pass.skipped).length,
      latencyMs: computePercentiles(this.passes.map((pass) => pass.durationMs)),
    };
  }

  /** Whether an extractor found a value on one pass. The value itself is never kept. */
  recordVariable(input: { name: string; setBy: string; server?: string; resolved: boolean }): void {
    const key = `${input.setBy}\0${input.name}`;
    const current = this.variables.get(key) ?? {
      name: input.name,
      setBy: input.setBy,
      ...(input.server ? { server: input.server } : {}),
      resolved: 0,
      missing: 0,
      resolvedRate: 0,
    };
    if (input.resolved) current.resolved++;
    else current.missing++;
    current.resolvedRate = current.resolved / (current.resolved + current.missing);
    this.variables.set(key, current);
  }

  buildVariables(): VariableSummary[] {
    return [...this.variables.values()];
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

  /** Series key: the tool name alone on a single-server run, else server and tool. */
  private seriesKey(obs: CallObservation, name: string): string {
    return this.multiServer ? `${obs.server ?? ""}\0${name}` : name;
  }

  buildToolSeries(): ToolSeries[] {
    const byTool = new Map<string, CallObservation[]>();
    for (const obs of this.observations) {
      if (obs.method !== "tools/call" || !obs.toolName) continue;
      const key = this.seriesKey(obs, obs.toolName);
      const list = byTool.get(key) ?? [];
      list.push(obs);
      byTool.set(key, list);
    }

    return [...byTool.values()].map((obs) => {
      const toolName = obs[0]!.toolName!;
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
        ...(this.multiServer && obs[0]?.server ? { server: obs[0].server } : {}),
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
      const key = this.seriesKey(obs, obs.method);
      const list = byMethod.get(key) ?? [];
      list.push(obs);
      byMethod.set(key, list);
    }

    return [...byMethod.values()].map((obs) => {
      const method = obs[0]!.method;
      const errors = obs.filter((o) => o.errorClass !== "none");
      return {
        ...(this.multiServer && obs[0]?.server ? { server: obs[0].server } : {}),
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
