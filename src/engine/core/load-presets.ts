import type { CallSlo } from "./call-slo.js";
import type { LoadProfile, SuiteNode } from "./suite-model.js";

export type LoadPresetId = "smoke" | "baseline" | "peak" | "spike" | "soak";

export interface LoadPresetDescriptor {
  id: LoadPresetId;
  label: string;
  shortLabel: string;
  badgeColor: string;
  description: string;
  load: LoadProfile;
  sloMultiplier: number;
}

export const LOAD_PRESETS: Record<LoadPresetId, LoadPresetDescriptor> = {
  smoke: {
    id: "smoke",
    label: "🟢 Smoke Test",
    shortLabel: "Smoke (1 VU · 1 pass)",
    badgeColor: "#22c55e",
    description: "1 VU · 1 pass · 0s hold · 0s ramp · 100ms dwell · 1 lane — fast functional & SLO contract check.",
    load: {
      maxConcurrency: 1,
      iterations: 1,
      durationMs: 0,
      rampUpMs: 0,
      rampDownMs: 30000,
      jitterMs: 0,
      dwellMs: 100,
      lanes: 1,
    },
    sloMultiplier: 1.0,
  },
  baseline: {
    id: "baseline",
    label: "🟡 Steady Baseline",
    shortLabel: "Baseline (3 VUs · 15s)",
    badgeColor: "#eab308",
    description: "3 VUs · 3 passes · 15s hold · 3s ramp · 75ms dwell · 2 lanes — steady multi-user baseline.",
    load: {
      maxConcurrency: 3,
      iterations: 3,
      durationMs: 15000,
      rampUpMs: 3000,
      rampDownMs: 30000,
      jitterMs: 50,
      dwellMs: 75,
      lanes: 2,
    },
    sloMultiplier: 1.15,
  },
  peak: {
    id: "peak",
    label: "🟠 Peak Load",
    shortLabel: "Peak (8 VUs · 30s)",
    badgeColor: "#f97316",
    description: "8 VUs · 5 passes · 30s hold · 5s ramp · 50ms dwell · 4 lanes — sustained peak concurrency.",
    load: {
      maxConcurrency: 8,
      iterations: 5,
      durationMs: 30000,
      rampUpMs: 5000,
      rampDownMs: 45000,
      jitterMs: 50,
      dwellMs: 50,
      lanes: 4,
    },
    sloMultiplier: 1.25,
  },
  spike: {
    id: "spike",
    label: "🔴 Spike Burst",
    shortLabel: "Spike (12 VUs · 1s ramp)",
    badgeColor: "#ef4444",
    description: "12 VUs · 6 passes · 20s hold · 1s ramp · 25ms dwell · 4 lanes — sudden burst stress test.",
    load: {
      maxConcurrency: 12,
      iterations: 6,
      durationMs: 20000,
      rampUpMs: 1000,
      rampDownMs: 45000,
      jitterMs: 25,
      dwellMs: 25,
      lanes: 4,
    },
    sloMultiplier: 1.4,
  },
  soak: {
    id: "soak",
    label: "🟣 Soak Test (10 VUs · 1h · ~4 TPS/user)",
    shortLabel: "Soak (10 VUs · 1h · 40 TPS)",
    badgeColor: "#a855f7",
    description: "10 VUs · 3600s (1h) hold · ~4 TPS/user (~40 TPS total, 250ms pacing) · 4 lanes — 1-hour endurance soak with image-gen & expensive-LLM bypass.",
    load: {
      maxConcurrency: 10,
      iterations: 10_000,
      durationMs: 3_600_000,
      rampUpMs: 10_000,
      rampDownMs: 60_000,
      jitterMs: 25,
      dwellMs: 220,
      lanes: 4,
    },
    sloMultiplier: 1.25,
  },
};

export interface ParsedConversationalSuiteUpdate {
  presetUsed?: LoadPresetId;
  load: LoadProfile;
  slo: CallSlo;
  nodes: SuiteNode[];
  changelog: string;
  summary: string;
}

function parseTimeMs(rawVal: string, unit: string): number {
  const num = Number.parseFloat(rawVal);
  if (!Number.isFinite(num) || num < 0) return 0;
  const u = unit.toLowerCase();
  if (u === "h" || u === "hr" || u === "hrs" || u === "hour" || u === "hours") {
    return Math.round(num * 3_600_000);
  }
  if (u === "m" || u === "min" || u === "mins" || u === "minute" || u === "minutes") {
    return Math.round(num * 60_000);
  }
  if (u === "s" || u === "sec" || u === "secs" || u === "second" || u === "seconds") {
    return Math.round(num * 1000);
  }
  return Math.round(num);
}

/**
 * Parse a natural-language conversational prompt or preset selection into an updated
 * `LoadProfile`, `CallSlo`, and optional filtered/focused `SuiteNode[]` tree.
 */
export function parseConversationalSuitePrompt(input: {
  prompt?: string;
  preset?: LoadPresetId;
  currentLoad: LoadProfile;
  currentSlo?: CallSlo;
  currentNodes: SuiteNode[];
  scaleSlos?: boolean;
}): ParsedConversationalSuiteUpdate {
  const rawPrompt = (input.prompt ?? "").trim();
  const lower = rawPrompt.toLowerCase();

  let detectedPreset: LoadPresetId | undefined = input.preset;
  if (!detectedPreset) {
    if (/\bsoak\b|\bendurance\b|\blong[- ]run\b/.test(lower)) detectedPreset = "soak";
    else if (/\bspike\b|\bburst\b/.test(lower)) detectedPreset = "spike";
    else if (/\bpeak\b|\bstress\b|\bhigh[- ]load\b/.test(lower)) detectedPreset = "peak";
    else if (/\bbaseline\b|\bsteady\b/.test(lower)) detectedPreset = "baseline";
    else if (/\bsmoke\b|\bsanity\b|\bquick\b/.test(lower)) detectedPreset = "smoke";
  }

  const basePreset = detectedPreset ? LOAD_PRESETS[detectedPreset] : undefined;
  const load: LoadProfile = basePreset
    ? { ...basePreset.load }
    : { ...input.currentLoad };

  // Extract explicit numbers from natural language prompt
  const vuMatch = lower.match(/(\d+)\s*(?:vus?|virtual\s+users?|concurrent\s+users?|users?|concurrency)/);
  if (vuMatch) {
    load.maxConcurrency = Math.max(1, Math.min(50, Number.parseInt(vuMatch[1]!, 10)));
  }

  const passMatch = lower.match(/(\d+)\s*(?:passes|pass|iterations?|iters?|runs?)/);
  if (passMatch) {
    load.iterations = Math.max(1, Math.min(500, Number.parseInt(passMatch[1]!, 10)));
  }

  const laneMatch = lower.match(/(\d+)\s*(?:lanes?|parallel\s+lanes?)/);
  if (laneMatch) {
    load.lanes = Math.max(1, Math.min(16, Number.parseInt(laneMatch[1]!, 10)));
  }

  const tpsMatch = lower.match(/(\d+(?:\.\d+)?)\s*(?:tps|rps|calls?\/s|req\/s)(?:\s*(?:per|\/ )\s*user)?/);
  if (tpsMatch) {
    const tpsVal = Number.parseFloat(tpsMatch[1]!);
    if (Number.isFinite(tpsVal) && tpsVal > 0) {
      const perUserTps = lower.includes("per user") || lower.includes("/user") || lower.includes("/u")
        ? tpsVal
        : tpsVal / Math.max(1, load.maxConcurrency);
      load.dwellMs = Math.max(10, Math.round(1000 / Math.max(0.2, perUserTps)) - 30);
    }
  }

  const dwellMatch = lower.match(/(?:dwell(?:\s+of)?\s*(\d+(?:\.\d+)?)\s*(ms|s)|(\d+(?:\.\d+)?)\s*(ms|s)\s*dwell)/);
  if (dwellMatch) {
    const val = dwellMatch[1] ?? dwellMatch[3]!;
    const unit = dwellMatch[2] ?? dwellMatch[4]!;
    load.dwellMs = Math.max(0, Math.min(30_000, parseTimeMs(val, unit)));
  }

  const rampMatch = lower.match(/ramp(?:ing|-?up)?(?:\s+over|\s+of|\s+for)?\s*(\d+(?:\.\d+)?)\s*(ms|s|m|min|mins|sec|secs)/) ?? lower.match(/(\d+(?:\.\d+)?)\s*(ms|s|m|min|mins|sec|secs)\s*ramp(?:-?up)?\b/);
  if (rampMatch) {
    load.rampUpMs = Math.max(0, Math.min(300_000, parseTimeMs(rampMatch[1]!, rampMatch[2]!)));
  }

  const holdMatch = lower.match(/(?:(?:for|hold|duration(?:\s+of)?)\s*(\d+(?:\.\d+)?)\s*(ms|s|m|min|mins|minute|minutes|sec|secs|second|seconds|h|hr|hrs|hour|hours)|(\d+(?:\.\d+)?)\s*(s|m|min|mins|minute|minutes|sec|secs|second|seconds|h|hr|hrs|hour|hours)\s*(?:hold|duration|soak|peak|run))/);
  if (holdMatch) {
    const val = holdMatch[1] ?? holdMatch[3]!;
    const unit = holdMatch[2] ?? holdMatch[4]!;
    load.durationMs = Math.max(0, Math.min(7_200_000, parseTimeMs(val, unit)));
  }

  const slo: CallSlo = {
    maxP95Ms: input.currentSlo?.maxP95Ms ?? 2500,
    maxP99Ms: input.currentSlo?.maxP99Ms ?? 3500,
    maxErrorRate: input.currentSlo?.maxErrorRate ?? 0.05,
  };

  if (input.scaleSlos && basePreset && basePreset.sloMultiplier !== 1.0) {
    slo.maxP95Ms = Math.round((slo.maxP95Ms ?? 2500) * basePreset.sloMultiplier);
    slo.maxP99Ms = Math.round((slo.maxP99Ms ?? 3500) * basePreset.sloMultiplier);
  }

  const tightenMatch = lower.match(/tighten\s+(?:p95\s+)?slos?\s+by\s+(\d+(?:\.\d+)?)\s*%/);
  if (tightenMatch) {
    const pct = Math.min(80, Math.max(1, Number.parseFloat(tightenMatch[1]!)));
    const factor = 1 - pct / 100;
    slo.maxP95Ms = Math.max(50, Math.round((slo.maxP95Ms ?? 2500) * factor));
    slo.maxP99Ms = Math.max(100, Math.round((slo.maxP99Ms ?? 3500) * factor));
  }
  const relaxMatch = lower.match(/(?:relax|loosen|increase)\s+(?:p95\s+)?slos?\s+by\s+(\d+(?:\.\d+)?)\s*%/);
  if (relaxMatch) {
    const pct = Math.min(300, Math.max(1, Number.parseFloat(relaxMatch[1]!)));
    const factor = 1 + pct / 100;
    slo.maxP95Ms = Math.max(50, Math.round((slo.maxP95Ms ?? 2500) * factor));
    slo.maxP99Ms = Math.max(100, Math.round((slo.maxP99Ms ?? 3500) * factor));
  }

  const p95Match =
    lower.match(/p95(?:\s+slo)?(?:\s+under|\s+to|\s+at|\s*<=?)?\s*(\d+(?:\.\d+)?)\s*(ms|s)/) ??
    lower.match(/(\d+(?:\.\d+)?)\s*(ms|s)\s*p95/);
  if (p95Match) {
    slo.maxP95Ms = Math.max(50, parseTimeMs(p95Match[1]!, p95Match[2]!));
    if ((slo.maxP99Ms ?? 0) < slo.maxP95Ms) {
      slo.maxP99Ms = Math.round(slo.maxP95Ms * 1.4);
    }
  }

  const p99Match =
    lower.match(/p99(?:\s+slo)?(?:\s+under|\s+to|\s+at|\s*<=?)?\s*(\d+(?:\.\d+)?)\s*(ms|s)/) ??
    lower.match(/(\d+(?:\.\d+)?)\s*(ms|s)\s*p99/);
  if (p99Match) {
    slo.maxP99Ms = Math.max(50, parseTimeMs(p99Match[1]!, p99Match[2]!));
  }
  if (slo.maxP95Ms !== undefined && slo.maxP99Ms !== undefined && slo.maxP99Ms < slo.maxP95Ms) slo.maxP99Ms = slo.maxP95Ms;

  // Optional tool focus filtering if the user asks to "focus on <tool1>, <tool2>" or "only run <tool1>"
  let nextNodes = structuredClone(input.currentNodes);
  if (input.scaleSlos && basePreset && basePreset.sloMultiplier > 1.0) {
    const scaleWalk = (items: SuiteNode[]) => {
      for (const n of items) {
        if (n.slo?.maxP95Ms) {
          n.slo.maxP95Ms = Math.max(n.slo.maxP95Ms, slo.maxP95Ms ?? 2500);
          // Scale p99 with p95 so a step never ends up with p95 above its p99.
          if (n.slo.maxP99Ms !== undefined) n.slo.maxP99Ms = Math.max(n.slo.maxP99Ms, slo.maxP99Ms ?? 3500, n.slo.maxP95Ms);
        }
        if (n.children) scaleWalk(n.children);
      }
    };
    scaleWalk(nextNodes);
  }

  const focusMatch = lower.match(/(?:focus(?:ing)?\s+on|only\s+(?:run|enable|test))\s+([a-z0-9_,\sand]+)/);
  const focusedTools: string[] = [];
  if (focusMatch) {
    const candidates = focusMatch[1]!
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter((s) => s.includes("_") || s.startsWith("skill") || s.startsWith("agent") || s.startsWith("swarm"));
    if (candidates.length > 0) {
      focusedTools.push(...candidates);
      const filterWalk = (items: SuiteNode[]) => {
        for (const n of items) {
          if (n.type === "sampler" && n.method === "tools/call" && n.tool) {
            n.enabled = focusedTools.includes(n.tool.toLowerCase());
          }
          if (n.children) filterWalk(n.children);
        }
      };
      filterWalk(nextNodes);
    }
  }

  const profileTag = basePreset ? basePreset.label.replace(/^[^\w]+/, "").trim() : "Custom Profile";
  const summaryParts = [
    `${profileTag}: ${load.maxConcurrency} VU${load.maxConcurrency === 1 ? "" : "s"}`,
    `${load.iterations ?? 1} pass${(load.iterations ?? 1) === 1 ? "" : "es"}`,
    `${Math.round(load.durationMs / 1000)}s hold`,
    `${Math.round(load.rampUpMs / 1000)}s ramp`,
    `${load.dwellMs ?? 100}ms dwell`,
    `${load.lanes ?? 1} lane${(load.lanes ?? 1) === 1 ? "" : "s"}`,
    `p95 ≤${slo.maxP95Ms}ms`,
  ];
  if (focusedTools.length > 0) {
    summaryParts.push(`focused on [${focusedTools.join(", ")}]`);
  }
  const summary = summaryParts.join(" · ");
  const changelog = rawPrompt
    ? `${summary} — "${rawPrompt.slice(0, 120)}"`
    : `Applied ${summary}`;

  return {
    presetUsed: detectedPreset,
    load,
    slo,
    nodes: nextNodes,
    changelog,
    summary,
  };
}

export function detectLoadPresetFromProfile(load: Partial<LoadProfile> | undefined): LoadPresetDescriptor {
  if (!load) return LOAD_PRESETS.smoke;
  const dur = load.durationMs ?? 0;
  const vus = load.maxConcurrency ?? 1;
  const ramp = load.rampUpMs ?? 0;
  if (dur >= 60_000 || (load.iterations ?? 1) >= 10) return LOAD_PRESETS.soak;
  if (vus >= 11 || (vus >= 8 && ramp <= 1500 && dur > 0)) return LOAD_PRESETS.spike;
  if (vus >= 6 || dur >= 25_000) return LOAD_PRESETS.peak;
  if (vus >= 2 || dur >= 5_000) return LOAD_PRESETS.baseline;
  return LOAD_PRESETS.smoke;
}

