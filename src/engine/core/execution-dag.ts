import type { CompiledStep, SuiteNode } from "./suite-model.js";

const BUILTIN_VARS = new Set(["__uuid", "__ts", "__thread", "__iter", "__loop"]);
const VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

interface DagEdge {
  source: string;
  target: string;
}

interface Block {
  entry: string[];
  exit: string[];
  all: string[];
  role: "initialize" | "teardown" | "think" | "extract" | "work" | "region";
  reads: string[];
  variable?: string;
}

function readsOf(node: SuiteNode): string[] {
  const haystack = JSON.stringify({
    label: node.label,
    tool: node.tool,
    prompt: node.prompt,
    resourceUri: node.resourceUri,
    path: node.path,
    args: node.args,
  });
  const found = new Set<string>();
  for (const match of haystack.matchAll(VAR_PATTERN)) {
    const name = match[1];
    if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || BUILTIN_VARS.has(name)) continue;
    found.add(name);
  }
  return [...found];
}

function roleOf(node: SuiteNode): Block["role"] {
  if (node.type === "think") return "think";
  if (node.type === "extractor") return "extract";
  if (node.method === "initialize") return "initialize";
  if (node.method === "teardown") return "teardown";
  return "work";
}

function unique(ids: string[]): string[] {
  return [...new Set(ids)];
}

/**
 * Direct predecessors for every step.
 * Initialize opens the suite. Teardown closes it. Thinks and loops are barriers.
 * An extractor reads the previous block. Independent calls share a wave.
 */
export function dagPredecessors(
  nodes: SuiteNode[],
  options?: { includeDisabled?: boolean },
): Map<string, string[]> {
  const planned = planList(nodes, options?.includeDisabled ?? false);
  const map = new Map<string, string[]>();
  for (const id of planned.all) map.set(id, []);
  for (const edge of planned.edges) {
    const list = map.get(edge.target) ?? [];
    if (!list.includes(edge.source)) list.push(edge.source);
    map.set(edge.target, list);
  }
  return map;
}

function planList(
  list: SuiteNode[],
  includeDisabled: boolean,
): { edges: DagEdge[]; entry: string[]; exit: string[]; all: string[] } {
  const edges: DagEdge[] = [];
  const blocks = collectBlocks(list, includeDisabled, edges);
  edges.push(...linkBlocks(blocks));
  const all = blocks.flatMap((block) => block.all);
  const incoming = new Set(edges.map((edge) => edge.target));
  const outgoing = new Set(edges.map((edge) => edge.source));
  return {
    edges,
    all,
    entry: all.filter((id) => !incoming.has(id)),
    exit: all.filter((id) => !outgoing.has(id)),
  };
}

function collectBlocks(list: SuiteNode[], includeDisabled: boolean, edges: DagEdge[]): Block[] {
  const blocks: Block[] = [];
  for (const node of list) {
    if (!node.enabled && !includeDisabled) continue;
    if (node.type === "group") {
      blocks.push(...collectBlocks(node.children ?? [], includeDisabled, edges));
      continue;
    }
    if (node.type === "loop") {
      const inner = planList(node.children ?? [], includeDisabled);
      edges.push(...inner.edges);
      if (inner.all.length === 0) continue;
      blocks.push({
        role: "region",
        entry: inner.entry,
        exit: inner.exit,
        all: inner.all,
        reads: [],
      });
      continue;
    }
    if (node.type === "sampler" && !node.method) continue;
    const id = node.id;
    blocks.push({
      role: roleOf(node),
      entry: [id],
      exit: [id],
      all: [id],
      reads: readsOf(node),
      variable: node.type === "extractor" ? node.variable?.trim() : undefined,
    });
  }
  return blocks;
}

function linkBlocks(blocks: Block[]): DagEdge[] {
  const edges: DagEdge[] = [];
  const seen = new Set<string>();
  const producers = new Map<string, string[]>();
  let gate: string[] = [];
  let wave: Block[] = [];
  let previous: Block | null = null;

  const add = (sources: string[], targets: string[]) => {
    for (const target of targets) {
      for (const source of sources) {
        if (!source || source === target) continue;
        const key = `${source}->${target}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ source, target });
      }
    }
  };

  const attach = (block: Block, preds: string[]) => {
    add(preds, block.entry);
    for (const name of block.reads) add(producers.get(name) ?? [], block.entry);
  };

  const flush = (): string[] => {
    const exits: string[] = [];
    for (const block of wave) {
      attach(block, gate);
      exits.push(...block.exit);
    }
    wave = [];
    return exits;
  };

  blocks.forEach((block, index) => {
    if (block.role === "work") {
      wave.push(block);
    } else if (block.role === "extract") {
      add(previous ? previous.exit : gate, block.entry);
      if (block.variable) producers.set(block.variable, block.exit);
    } else if (block.role === "teardown") {
      flush();
      const sources = new Set(edges.map((edge) => edge.source));
      const leaves = blocks.slice(0, index).flatMap((item) => item.exit).filter((id) => !sources.has(id));
      attach(block, leaves.length > 0 ? leaves : gate);
      gate = block.exit;
    } else {
      const flushed = flush();
      attach(block, unique([...gate, ...flushed]));
      gate = block.exit;
    }
    previous = block;
  });
  flush();
  return edges;
}

/** Write each compiled step's predecessor indexes. Loop iterations wait for the previous pass. */
export function assignWaitFor(steps: CompiledStep[], predecessors: Map<string, string[]>): void {
  const appearances = new Map<string, number[]>();
  steps.forEach((step, index) => {
    const id = step.nodeId;
    if (!id) return;
    const list = appearances.get(id) ?? [];
    list.push(index);
    appearances.set(id, list);
  });
  steps.forEach((step, index) => {
    const waits = new Set<number>();
    const sources = step.nodeId ? predecessors.get(step.nodeId) ?? [] : [];
    for (const source of sources) {
      const hits = (appearances.get(source) ?? []).filter((hit) => hit < index);
      const sameLoop = hits.filter((hit) => steps[hit]?.loopIndex === step.loopIndex);
      const chosen = (sameLoop.length > 0 ? sameLoop : hits).at(-1);
      if (chosen !== undefined) waits.add(chosen);
    }
    step.waitFor = [...waits];
  });
  steps.forEach((step, index) => {
    const waits = new Set(step.waitFor ?? []);
    for (const key of step.barriers ?? []) {
      const split = key.lastIndexOf("#");
      const iter = Number(key.slice(split + 1));
      if (!Number.isFinite(iter) || iter <= 0) continue;
      const prevKey = `${key.slice(0, split)}#${iter - 1}`;
      const internal = [...waits].some((hit) => (steps[hit]?.barriers ?? []).includes(key));
      if (internal) continue;
      steps.forEach((other, hit) => {
        if (hit < index && (other.barriers ?? []).includes(prevKey)) waits.add(hit);
      });
    }
    step.waitFor = [...waits];
  });
  for (const step of steps) delete step.barriers;
}
