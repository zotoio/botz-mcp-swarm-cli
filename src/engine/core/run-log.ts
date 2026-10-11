/** Lines kept for the execution console and the stored run log. */
export const RUN_LOG_TAIL = 2000;

/** One console line for every progress event, including server stderr. */
export function formatRunLog(event: {
  ts?: string;
  name: string;
  attributes: Record<string, string | number | boolean>;
}): string {
  const time = event.ts && event.ts.length >= 23 ? event.ts.slice(11, 23) : (event.ts ?? "");
  if (event.name === "sut.stderr") {
    const node = String(event.attributes.node ?? "");
    const line = String(event.attributes.line ?? "");
    return node ? `${time}  stderr  node=${node}  ${line}` : `${time}  stderr  ${line}`;
  }
  const attrs = Object.entries(event.attributes)
    .filter(([, value]) => value !== "")
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  return attrs ? `${time}  ${event.name}  ${attrs}` : `${time}  ${event.name}`;
}

export function tailRunLog(events: Array<{ ts?: string; name: string; attributes: Record<string, string | number | boolean> }>): string[] {
  return events.map(formatRunLog).slice(-RUN_LOG_TAIL);
}

function hasToken(line: string, token: string): boolean {
  let from = 0;
  while (from < line.length) {
    const at = line.indexOf(token, from);
    if (at < 0) return false;
    const before = at === 0 ? " " : line[at - 1];
    const after = line[at + token.length];
    if ((before === " " || before === "\t") && (after === undefined || after === " " || after === "\t")) return true;
    from = at + token.length;
  }
  return false;
}

/** One invocation of a step, taken from an `mcp.step` log line. */
export interface StepCall {
  time: string;
  phase: "start" | "done";
  result: string;
  latencyMs: number | null;
  /** Zero-based suite pass on that virtual user, when the run recorded it. */
  iter: number | null;
  /** Zero-based virtual user, when the run recorded it. */
  thread: number | null;
  /** Zero-based loop pass, when the run recorded it. */
  loop: number | null;
}

function attrNumber(line: string, name: string): number | null {
  const match = new RegExp(`(?:^|\\s)${name}=(\\d+)`).exec(line);
  return match ? Number(match[1]) : null;
}

/** Completed calls for a step, plus a trailing start that has not finished. */
export function stepCalls(lines: string[], nodeId: string): StepCall[] {
  const rows: StepCall[] = [];
  let open = 0;
  let openCall: StepCall | null = null;
  for (const line of linesForNode(lines, nodeId)) {
    if (!line.includes("  mcp.step  ")) continue;
    const phase = /phase=(start|done)/.exec(line)?.[1];
    if (phase !== "start" && phase !== "done") continue;
    const call: StepCall = {
      time: /^(\d{2}:\d{2}:\d{2}\.\d{3})/.exec(line)?.[1] ?? "",
      phase,
      result: /result=(\S+)/.exec(line)?.[1] ?? "",
      latencyMs: phase === "done" ? attrNumber(line, "latencyMs") : null,
      iter: attrNumber(line, "iter"),
      thread: attrNumber(line, "thread"),
      loop: attrNumber(line, "loop"),
    };
    if (phase === "start") {
      open += 1;
      openCall = call;
      continue;
    }
    open = Math.max(0, open - 1);
    if (open === 0) openCall = null;
    rows.push(call);
  }
  if (open > 0 && openCall) rows.push(openCall);
  return rows;
}

/** Lines whose `node=` attribute is this step. */
export function linesForNode(lines: string[], nodeId: string): string[] {
  const id = nodeId.trim();
  if (!id) return [];
  const token = `node=${id}`;
  return lines.filter((line) => hasToken(line, token));
}

/** Apply a regular expression. An empty pattern keeps every line. A broken pattern keeps every line and reports the error. */
export function filterLogLines(lines: string[], pattern: string): { lines: string[]; error: string | null } {
  const source = pattern.trim();
  if (!source) return { lines, error: null };
  try {
    const expression = new RegExp(source, "i");
    return { lines: lines.filter((line) => expression.test(line)), error: null };
  } catch (error) {
    return { lines, error: error instanceof Error ? error.message : "Invalid regular expression" };
  }
}
