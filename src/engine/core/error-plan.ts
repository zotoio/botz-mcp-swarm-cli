export interface ErrorAction {
  cause: string;
  action: string;
  evidence: string;
  /** Tool name parsed from the evidence, when the row can open that step. */
  tool?: string;
}

function toolFromEvidence(evidence: string): string | undefined {
  const named = evidence.match(/\btool=([A-Za-z0-9_.:-]+)/);
  if (named?.[1]) return named[1];
  const step = evidence.match(/^Step ([A-Za-z0-9_.:-]+)/);
  return step?.[1];
}

const RULES: Array<{ test: (text: string) => boolean; cause: string; action: string }> = [
  {
    test: (text) => /silent green/i.test(text),
    cause: "The run intended traffic and recorded no pass or fail.",
    action: "Enable at least one step, confirm the server answers initialize, and run again.",
  },
  {
    test: (text) => /warm-up failed|session warm-up/i.test(text),
    cause: "The suite could not open a session, so no step ran.",
    action: "Confirm the server is listening at the suite URL, then retry the suite. Retry starts a new execution.",
  },
  {
    test: (text) => /allowlist/i.test(text),
    cause: "The target is outside the allowlist.",
    action: "Add this server on the Servers page, then run the suite again.",
  },
  {
    test: (text) => /error_class=auth|result=auth|\bunauthorized\b|(?<![\d.=])401(?!\d)/i.test(text),
    cause: "The server rejected the call as unauthorized.",
    action: "Check the credential on the server step, then run the suite again.",
  },
  {
    test: (text) => /error_class=timeout|result=timeout|\btimeout\b/i.test(text),
    cause: "A call exceeded its time limit.",
    action: "Give that step more time, or lower virtual users, then run again.",
  },
  {
    test: (text) =>
      (/error_class=transport|result=transport|econnrefused|enotfound|failed to connect|connection closed|connection reset/i.test(text)
        || (/fetch failed/i.test(text) && !/warm-up/i.test(text))),
    cause: "The swarm could not reach the server.",
    action: "Check the command or URL, confirm the process is listening, and run again.",
  },
  {
    test: (text) => /error_class=protocol|result=protocol|-3260|method not found/i.test(text),
    cause: "The call does not match what the server implements.",
    action: "Refresh the server and run Check compatibility, then fix the step that drifted.",
  },
  {
    test: (text) => /error_class=quota|result=quota|\bquota\b/i.test(text),
    cause: "The run hit a quota.",
    action: "Raise the quota or shorten the run, then start it again.",
  },
  {
    test: (text) => /error_rate/i.test(text),
    cause: "A tool's error rate is over the suite limit.",
    action: "Open that tool's step, use the error class in the log, and fix the call or the server.",
  },
  {
    test: (text) => /\bp9[59]\b/i.test(text),
    cause: "A call's duration is over its objective.",
    action: "Compare this run with the previous one, then slow the ramp or fix the slow tool.",
  },
  {
    test: (text) => /ramp-down/i.test(text),
    cause: "The suite was still running when ramp-down ended.",
    action: "Give the run more time, or lower iterations, then run again.",
  },
  {
    test: (text) =>
      (/scenario .+ (fail|error)/i.test(text) || /phase=done result=fail/.test(text))
      && !/connection closed|connection reset|econnrefused|fetch failed|ramp-down/i.test(text),
    cause: "A step failed.",
    action: "Open the failed step, correct its arguments or the server response, and run again.",
  },
  {
    test: (text) => /protocol version/i.test(text),
    cause: "The suite's protocol label does not match the version the server negotiated.",
    action: "Set the suite protocol label to the negotiated version and run again.",
  },
  {
    test: (text) => /rss max|cpu max/i.test(text),
    cause: "Worker or server memory or CPU crossed its limit.",
    action: "Lower virtual users or the duration, then compare the cost gauges on the next run.",
  },
  {
    test: (text) => /soak mode requires/i.test(text),
    cause: "The soak has no duration and no iteration cap.",
    action: "Set a duration or a maximum iteration count, then start the soak again.",
  },
  {
    test: (text) => /error_class=application|result=application/.test(text),
    cause: "A tool returned an application error.",
    action: "Read that tool's stderr line and fix the arguments or the tool.",
  },
];

/** Group fail reasons and log lines into causes, each with one next action. */
export function planErrors(input: { failReasons?: string[]; log?: string[] }): ErrorAction[] {
  const lines = [...(input.failReasons ?? []), ...(input.log ?? [])];
  const planned: ErrorAction[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const text = line.trim();
    if (!text) continue;
    for (const rule of RULES) {
      if (seen.has(rule.cause) || !rule.test(text)) continue;
      seen.add(rule.cause);
      const evidence = text.slice(0, 240);
      const tool = toolFromEvidence(evidence);
      planned.push({ cause: rule.cause, action: rule.action, evidence, ...(tool ? { tool } : {}) });
    }
  }
  return planned;
}
