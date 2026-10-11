import { dagPredecessors } from "./execution-dag.js";
import { updateNode, type SuiteNode, type SuiteNodeType } from "./suite-model.js";

/** Card size on the suite graph. Frames are larger and hold their steps inside. */
export const SUITE_CARD_WIDTH = 232;
export const SUITE_CARD_HEIGHT = 104;

/** Ready steps that share one Promise.all batch, drawn as columns in a downward rank. */
export const DEFAULT_LANES = 4;
/** Dashboard fan: three steps across, then the next rank drops down. */
const FAN_COLUMNS = 3;
/** One rank of the execution DAG. Wide enough that a parallel wave stays on one band. */
const DAG_COLUMNS = 8;
const FAN_STAGGER = 28;
const GAP_X = 96;
const GAP_Y = 104;
const FRAME_PAD = 28;
/** Room under the frame title so the entry wire can drop onto the first step. */
const FRAME_HEADER = 112;
/** Extra room on the right so a wrapped run-order wire stays inside the frame. */
const WIRE_GUTTER = 40;
const EMPTY_FRAME = { width: 360, height: 188 };

const BUILTIN_VARS = new Set(["__uuid", "__ts", "__thread", "__iter", "__loop"]);
const VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export interface GraphPoint {
  x: number;
  y: number;
}

export interface GraphEdit {
  nodes: SuiteNode[];
  applied: boolean;
  error?: string;
}

export type SuiteEdgeKind = "flow" | "entry" | "data";

export interface SuiteEdge {
  kind: SuiteEdgeKind;
  source: string;
  target: string;
  variable?: string;
}

export interface OutlineRow {
  id: string;
  depth: number;
  label: string;
  type: SuiteNodeType;
  enabled: boolean;
  order: number | null;
}

interface Located {
  parent: SuiteNode | null;
  list: SuiteNode[];
  index: number;
}

function roundPoint(point: GraphPoint): GraphPoint {
  return { x: Math.round(point.x), y: Math.round(point.y) };
}

function isFrame(node: SuiteNode): boolean {
  return node.type === "group" || node.type === "loop";
}

function locate(nodes: SuiteNode[], id: string, parent: SuiteNode | null = null): Located | null {
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    if (!node) continue;
    if (node.id === id) return { parent, list: nodes, index };
    if (node.children) {
      const nested = locate(node.children, id, node);
      if (nested) return nested;
    }
  }
  return null;
}

function findOnce(nodes: SuiteNode[], id: string): SuiteNode | null {
  const found = locate(nodes, id);
  return found ? found.list[found.index] ?? null : null;
}

export function findSuiteNode(nodes: SuiteNode[], id: string): SuiteNode | null {
  return findOnce(nodes, id);
}

export function parentIdOf(nodes: SuiteNode[], id: string): string | null {
  return locate(nodes, id)?.parent?.id ?? null;
}

function containsNode(node: SuiteNode, id: string): boolean {
  if (node.id === id) return true;
  return (node.children ?? []).some((child) => containsNode(child, id));
}

function detach(nodes: SuiteNode[], id: string): { nodes: SuiteNode[]; removed: SuiteNode } | null {
  const tree = structuredClone(nodes);
  const found = locate(tree, id);
  if (!found) return null;
  const [removed] = found.list.splice(found.index, 1);
  if (!removed) return null;
  return { nodes: tree, removed };
}

function safeVariable(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
    && !BUILTIN_VARS.has(name)
    && name !== "__proto__"
    && name !== "prototype"
    && name !== "constructor";
}

/** Names a step reads as `${name}`, ignoring the built-in run tokens. */
export function referencedVariables(node: SuiteNode): string[] {
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
    if (name && safeVariable(name)) found.add(name);
  }
  return [...found];
}

export function referencesVariable(node: SuiteNode, name: string): boolean {
  return safeVariable(name) && referencedVariables(node).includes(name);
}

export function frameSize(node: SuiteNode, positions: Map<string, GraphPoint>): { width: number; height: number } {
  const children = node.children ?? [];
  if (children.length === 0) return { ...EMPTY_FRAME };
  let width = EMPTY_FRAME.width;
  let height = FRAME_HEADER + SUITE_CARD_HEIGHT + FRAME_PAD;
  for (const child of children) {
    const pos = positions.get(child.id) ?? { x: FRAME_PAD, y: FRAME_HEADER };
    const size = isFrame(child) ? frameSize(child, positions) : { width: SUITE_CARD_WIDTH, height: SUITE_CARD_HEIGHT };
    width = Math.max(width, pos.x + size.width + FRAME_PAD + WIRE_GUTTER);
    height = Math.max(height, pos.y + size.height + FRAME_PAD);
  }
  return { width, height };
}

function blockSize(node: SuiteNode, positions: Map<string, GraphPoint>): { width: number; height: number } {
  if (isFrame(node)) return frameSize(node, positions);
  return { width: SUITE_CARD_WIDTH, height: SUITE_CARD_HEIGHT };
}

/**
 * Positions for the suite graph and the dashboard.
 * Ranks run downward. Each rank is up to `lanes` columns, matching one Promise.all batch.
 * A stored layout replaces that spot.
 */
function samePoint(a: GraphPoint, b: GraphPoint): boolean {
  return Math.abs(a.x - b.x) < 8 && Math.abs(a.y - b.y) < 8;
}

/** A step saved without a position sits in the next free cell of the stored grid, not in a separate column. */
function seatUnstored(list: SuiteNode[], positions: Map<string, GraphPoint>): void {
  const stored = list.filter((node) => node.layout);
  if (!stored.length) return;
  const occupied: GraphPoint[] = [];
  for (const node of stored) {
    const point = roundPoint(node.layout!);
    positions.set(node.id, point);
    occupied.push(point);
  }
  const xs = [...new Set(occupied.map((point) => point.x))].sort((a, b) => a - b);
  const ys = [...new Set(occupied.map((point) => point.y))].sort((a, b) => a - b);
  const colW = xs.length >= 2 ? xs[1]! - xs[0]! : SUITE_CARD_WIDTH + GAP_X;
  const rowH = ys.length >= 2 ? ys[1]! - ys[0]! : SUITE_CARD_HEIGHT + GAP_Y;
  const originX = xs[0] ?? 0;
  const originY = ys[0] ?? 0;
  const columns = Math.max(xs.length, 1);
  const taken = (point: GraphPoint) => occupied.some((item) => samePoint(item, point));
  const cellAfter = (cursor: GraphPoint): GraphPoint => {
    const col = Math.max(0, Math.round((cursor.x - originX) / colW));
    const row = Math.max(0, Math.round((cursor.y - originY) / rowH));
    for (let r = row; r < row + list.length + 2; r += 1) {
      for (let c = r === row ? col + 1 : 0; c < columns; c += 1) {
        const point = roundPoint({ x: originX + c * colW, y: originY + r * rowH });
        if (!taken(point)) return point;
      }
    }
    return roundPoint({ x: originX, y: Math.max(...occupied.map((point) => point.y)) + rowH });
  };
  let cursor: GraphPoint | null = null;
  for (const node of list) {
    if (node.layout) {
      cursor = roundPoint(node.layout);
      continue;
    }
    if (!cursor) continue;
    const point = cellAfter(cursor);
    positions.set(node.id, point);
    occupied.push(point);
    cursor = point;
  }
}

export function resolvePositions(nodes: SuiteNode[], lanes = DEFAULT_LANES): Map<string, GraphPoint> {
  const positions = comfyPositions(nodes, lanes);
  const apply = (list: SuiteNode[]) => {
    seatUnstored(list, positions);
    for (const node of list) {
      if (node.children?.length) apply(node.children);
    }
  };
  apply(nodes);
  return positions;
}

function descendantIds(node: SuiteNode): string[] {
  const ids = [node.id];
  for (const child of node.children ?? []) ids.push(...descendantIds(child));
  return ids;
}

function ownerId(list: SuiteNode[], id: string): string | null {
  for (const node of list) {
    if (node.id === id || descendantIds(node).includes(id)) return node.id;
  }
  return null;
}

/** Ranks of the execution DAG. Independent steps share a rank and sit side by side. */
export function dagPositions(nodes: SuiteNode[]): Map<string, GraphPoint> {
  const positions = new Map<string, GraphPoint>();
  const predecessors = dagPredecessors(nodes, { includeDisabled: true });
  const place = (list: SuiteNode[], origin: GraphPoint) => {
    for (const node of list) {
      if (isFrame(node) && node.children?.length) place(node.children, { x: FRAME_PAD, y: FRAME_HEADER });
    }
    const rankOf = new Map<string, number>();
    const rank = (id: string, stack: Set<string>): number => {
      const cached = rankOf.get(id);
      if (cached !== undefined) return cached;
      if (stack.has(id)) return 0;
      stack.add(id);
      const node = list.find((item) => item.id === id);
      const sources = new Set<string>();
      const members = node && isFrame(node) ? descendantIds(node) : [id];
      for (const member of members) {
        for (const source of predecessors.get(member) ?? []) {
          const owner = ownerId(list, source);
          if (owner && owner !== id) sources.add(owner);
        }
      }
      const value = sources.size === 0 ? 0 : 1 + Math.max(...[...sources].map((source) => rank(source, stack)));
      stack.delete(id);
      rankOf.set(id, value);
      return value;
    };
    for (const node of list) rank(node.id, new Set());
    const bands = new Map<number, SuiteNode[]>();
    for (const node of list) {
      const level = rankOf.get(node.id) ?? 0;
      const band = bands.get(level) ?? [];
      band.push(node);
      bands.set(level, band);
    }
    let y = origin.y;
    for (const level of [...bands.keys()].sort((a, b) => a - b)) {
      let x = origin.x;
      let column = 0;
      let rowHeight = 0;
      for (const node of bands.get(level) ?? []) {
        const block = blockSize(node, positions);
        if (column >= DAG_COLUMNS) {
          column = 0;
          x = origin.x;
          y += rowHeight + GAP_Y;
          rowHeight = 0;
        }
        const stagger = column % 2 === 1 ? FAN_STAGGER : 0;
        positions.set(node.id, roundPoint({ x, y: y + stagger }));
        x += block.width + GAP_X;
        rowHeight = Math.max(rowHeight, block.height + stagger);
        column += 1;
      }
      y += rowHeight + GAP_Y;
    }
  };
  place(nodes, { x: 0, y: 0 });
  return positions;
}

/**
 * Execution graph drawn downward.
 * A rank is one wave of steps the executor can run together. The wave fills `lanes`
 * columns, then wraps to the next row, in suite order, which is the Promise.all batch order.
 */
export function comfyPositions(nodes: SuiteNode[], lanes = DEFAULT_LANES): Map<string, GraphPoint> {
  const positions = new Map<string, GraphPoint>();
  const predecessors = dagPredecessors(nodes, { includeDisabled: true });
  const place = (list: SuiteNode[], origin: GraphPoint) => {
    for (const node of list) {
      if (isFrame(node) && node.children?.length) place(node.children, { x: FRAME_PAD, y: FRAME_HEADER });
    }
    const rankOf = new Map<string, number>();
    const rank = (id: string, stack: Set<string>): number => {
      const cached = rankOf.get(id);
      if (cached !== undefined) return cached;
      if (stack.has(id)) return 0;
      stack.add(id);
      const node = list.find((item) => item.id === id);
      const sources = new Set<string>();
      const members = node && isFrame(node) ? descendantIds(node) : [id];
      for (const member of members) {
        for (const source of predecessors.get(member) ?? []) {
          const owner = ownerId(list, source);
          if (owner && owner !== id) sources.add(owner);
        }
      }
      const value = sources.size === 0 ? 0 : 1 + Math.max(...[...sources].map((source) => rank(source, stack)));
      stack.delete(id);
      rankOf.set(id, value);
      return value;
    };
    for (const node of list) rank(node.id, new Set());
    const bands = new Map<number, SuiteNode[]>();
    const indexOf = new Map(list.map((node, index) => [node.id, index]));
    for (const node of list) {
      const level = rankOf.get(node.id) ?? 0;
      const band = bands.get(level) ?? [];
      band.push(node);
      bands.set(level, band);
    }
    const laneCount = Math.max(1, Math.round(lanes));
    let y = origin.y;
    for (const level of [...bands.keys()].sort((a, b) => a - b)) {
      const band = [...(bands.get(level) ?? [])].sort(
        (a, b) => (indexOf.get(a.id) ?? 0) - (indexOf.get(b.id) ?? 0),
      );
      for (let start = 0; start < band.length; start += laneCount) {
        const row = band.slice(start, start + laneCount);
        let x = origin.x;
        let rowHeight = 0;
        for (const node of row) {
          positions.set(node.id, roundPoint({ x, y }));
          const block = blockSize(node, positions);
          x += block.width + GAP_X;
          rowHeight = Math.max(rowHeight, block.height);
        }
        y += rowHeight + GAP_Y;
      }
    }
  };
  place(nodes, { x: 0, y: 0 });
  return positions;
}

/** Ignore stored positions and spread each rank into a short, staggered fan. */
export function fanPositions(nodes: SuiteNode[]): Map<string, GraphPoint> {
  const positions = new Map<string, GraphPoint>();
  const place = (list: SuiteNode[], origin: GraphPoint) => {
    for (const node of list) {
      if (node.children?.length) place(node.children, { x: FRAME_PAD, y: FRAME_HEADER });
    }
    let x = origin.x;
    let y = origin.y;
    let rowHeight = 0;
    let column = 0;
    for (const node of list) {
      const block = blockSize(node, positions);
      if (column >= FAN_COLUMNS) {
        column = 0;
        x = origin.x;
        y += rowHeight + GAP_Y;
        rowHeight = 0;
      }
      const stagger = column % 2 === 1 ? FAN_STAGGER : 0;
      positions.set(node.id, roundPoint({ x, y: y + stagger }));
      x += block.width + GAP_X;
      rowHeight = Math.max(rowHeight, block.height + stagger);
      column += 1;
    }
  };
  place(nodes, { x: 0, y: 0 });
  return positions;
}

export function tidyPositions(nodes: SuiteNode[], lanes = DEFAULT_LANES): SuiteNode[] {
  const cleared = structuredClone(nodes);
  const strip = (list: SuiteNode[]) => {
    for (const node of list) {
      delete node.layout;
      if (node.children?.length) strip(node.children);
    }
  };
  strip(cleared);
  const positions = resolvePositions(cleared, lanes);
  const apply = (list: SuiteNode[]) => {
    for (const node of list) {
      const pos = positions.get(node.id);
      if (pos) node.layout = pos;
      if (node.children?.length) apply(node.children);
    }
  };
  apply(cleared);
  return cleared;
}

export function withLayout(nodes: SuiteNode[], id: string, point: GraphPoint): SuiteNode[] {
  return updateNode(nodes, id, { layout: roundPoint(point) });
}

/** Canvas size of one suite, origin at the top-left card. */
export function suiteExtent(nodes: SuiteNode[]): { width: number; height: number } {
  const positions = resolvePositions(nodes);
  let width = 360;
  let height = 120;
  const walk = (list: SuiteNode[], origin: GraphPoint) => {
    for (const node of list) {
      const local = positions.get(node.id) ?? { x: 0, y: 0 };
      const abs = { x: origin.x + local.x, y: origin.y + local.y };
      const size = blockSize(node, positions);
      width = Math.max(width, abs.x + size.width);
      height = Math.max(height, abs.y + size.height);
      if (node.children?.length) walk(node.children, abs);
    }
  };
  walk(nodes, { x: 0, y: 0 });
  return { width, height };
}

/** Deepest group or loop whose frame contains the canvas point. */
export function frameAtPoint(nodes: SuiteNode[], point: GraphPoint): { id: string; relative: GraphPoint } | null {
  const positions = resolvePositions(nodes);
  const found: { id: string; relative: GraphPoint; area: number } = { id: "", relative: { x: 0, y: 0 }, area: Number.POSITIVE_INFINITY };
  let hit = false;
  const walk = (list: SuiteNode[], origin: GraphPoint) => {
    for (const node of list) {
      const local = positions.get(node.id) ?? { x: 0, y: 0 };
      const abs = { x: origin.x + local.x, y: origin.y + local.y };
      if (isFrame(node)) {
        const size = frameSize(node, positions);
        const inside = point.x >= abs.x && point.y >= abs.y && point.x <= abs.x + size.width && point.y <= abs.y + size.height;
        if (inside) {
          const area = size.width * size.height;
          if (area < found.area) {
            hit = true;
            found.id = node.id;
            found.relative = roundPoint({ x: point.x - abs.x, y: point.y - abs.y });
            found.area = area;
          }
        }
      }
      if (node.children?.length) walk(node.children, abs);
    }
  };
  walk(nodes, { x: 0, y: 0 });
  return hit ? { id: found.id, relative: found.relative } : null;
}

/** Enabled steps in the order the runner calls them. Frames are containers, not steps. */
export function runOrder(nodes: SuiteNode[]): Map<string, number> {
  const order = new Map<string, number>();
  let next = 0;
  const walk = (list: SuiteNode[]) => {
    for (const node of list) {
      if (!node.enabled) continue;
      if (isFrame(node)) {
        walk(node.children ?? []);
        continue;
      }
      next += 1;
      order.set(node.id, next);
    }
  };
  walk(nodes);
  return order;
}

/** Steps the runner will visit, including enabled frames. */
export function liveNodeIds(nodes: SuiteNode[]): Set<string> {
  const ids = new Set<string>();
  const walk = (list: SuiteNode[]) => {
    for (const node of list) {
      if (!node.enabled) continue;
      ids.add(node.id);
      if (node.children?.length) walk(node.children);
    }
  };
  walk(nodes);
  return ids;
}

export function suiteOutline(nodes: SuiteNode[]): OutlineRow[] {
  const order = runOrder(nodes);
  const rows: OutlineRow[] = [];
  const walk = (list: SuiteNode[], depth: number) => {
    for (const node of list) {
      rows.push({
        id: node.id,
        depth,
        label: node.label?.trim() || node.type,
        type: node.type,
        enabled: node.enabled,
        order: order.get(node.id) ?? null,
      });
      if (node.children?.length) walk(node.children, depth + 1);
    }
  };
  walk(nodes, 0);
  return rows;
}

function flowAndEntry(nodes: SuiteNode[]): SuiteEdge[] {
  const edges: SuiteEdge[] = [];
  const walk = (list: SuiteNode[]) => {
    for (let index = 0; index < list.length; index++) {
      const node = list[index];
      const next = list[index + 1];
      if (node && next) edges.push({ kind: "flow", source: node.id, target: next.id });
      if (!node) continue;
      const first = node.children?.[0];
      if (isFrame(node) && first) edges.push({ kind: "entry", source: node.id, target: first.id });
      if (node.children?.length) walk(node.children);
    }
  };
  walk(nodes);
  return edges;
}

function dataEdges(nodes: SuiteNode[]): SuiteEdge[] {
  const extractors: SuiteNode[] = [];
  const all: SuiteNode[] = [];
  const walk = (list: SuiteNode[]) => {
    for (const node of list) {
      all.push(node);
      if (node.type === "extractor") extractors.push(node);
      if (node.children?.length) walk(node.children);
    }
  };
  walk(nodes);
  const edges: SuiteEdge[] = [];
  for (const extractor of extractors) {
    const variable = extractor.variable?.trim() ?? "";
    if (!safeVariable(variable)) continue;
    for (const target of all) {
      if (target.id === extractor.id) continue;
      if (!referencesVariable(target, variable)) continue;
      edges.push({ kind: "data", source: extractor.id, target: target.id, variable });
    }
  }
  return edges;
}

/** Run-order wires, frame entry wires, and `${variable}` wires. */
export function deriveEdges(nodes: SuiteNode[]): SuiteEdge[] {
  return [...flowAndEntry(nodes), ...dataEdges(nodes)];
}

/** Flow edges the runner honors: a wide DAG, not a chain of siblings. */
export function executionEdges(nodes: SuiteNode[]): SuiteEdge[] {
  const predecessors = dagPredecessors(nodes, { includeDisabled: true });
  const flow: SuiteEdge[] = [];
  for (const [target, sources] of predecessors) {
    for (const source of sources) flow.push({ kind: "flow", source, target });
  }
  const entry: SuiteEdge[] = [];
  const walk = (list: SuiteNode[]) => {
    for (const node of list) {
      if (!isFrame(node)) continue;
      const inside = new Set(descendantIds(node));
      for (const child of node.children ?? []) {
        if (isFrame(child)) {
          entry.push({ kind: "entry", source: node.id, target: child.id });
          continue;
        }
        const sources = (predecessors.get(child.id) ?? []).filter((source) => inside.has(source));
        if (sources.length === 0) entry.push({ kind: "entry", source: node.id, target: child.id });
      }
      walk(node.children ?? []);
    }
  };
  walk(nodes);
  return [...flow, ...entry, ...dataEdges(nodes)];
}

export function edgeId(edge: SuiteEdge): string {
  return `${edge.kind}:${edge.source}:${edge.target}:${edge.variable ?? ""}`;
}

/**
 * Make `targetId` run immediately after `sourceId`, in the source's frame.
 * Rejects a wire that would put a frame inside its own step.
 */
export function connectFlow(nodes: SuiteNode[], sourceId: string, targetId: string): GraphEdit {
  if (sourceId === targetId) return { nodes, applied: false, error: "A step cannot run after itself." };
  const source = findOnce(nodes, sourceId);
  const target = findOnce(nodes, targetId);
  if (!source || !target) return { nodes, applied: false, error: "That step is not in this suite." };
  if (containsNode(target, sourceId)) {
    return { nodes, applied: false, error: "That wire would place a frame inside a step it already holds." };
  }
  const sourceAt = locate(nodes, sourceId);
  const targetAt = locate(nodes, targetId);
  if (sourceAt && targetAt && sourceAt.parent?.id === targetAt.parent?.id && targetAt.index === sourceAt.index + 1) {
    return { nodes, applied: false };
  }
  const oldParent = parentIdOf(nodes, targetId);
  const detached = detach(nodes, targetId);
  if (!detached) return { nodes, applied: false, error: "That step is not in this suite." };
  const dest = locate(detached.nodes, sourceId);
  if (!dest) return { nodes, applied: false, error: "That step is not in this suite." };
  dest.list.splice(dest.index + 1, 0, detached.removed);
  if (oldParent !== parentIdOf(detached.nodes, targetId)) delete detached.removed.layout;
  return { nodes: detached.nodes, applied: true };
}

/** Make `nodeId` the first step inside a group or loop. */
export function connectEntry(nodes: SuiteNode[], frameId: string, nodeId: string): GraphEdit {
  if (frameId === nodeId) return { nodes, applied: false, error: "A frame cannot contain itself." };
  const frame = findOnce(nodes, frameId);
  const node = findOnce(nodes, nodeId);
  if (!frame || !node) return { nodes, applied: false, error: "That step is not in this suite." };
  if (!isFrame(frame)) return { nodes, applied: false, error: "Entry wires start from a group or a loop." };
  if (containsNode(node, frameId)) {
    return { nodes, applied: false, error: "That wire would place a frame inside a step it already holds." };
  }
  if (frame.children?.[0]?.id === nodeId) return { nodes, applied: false };
  const oldParent = parentIdOf(nodes, nodeId);
  const detached = detach(nodes, nodeId);
  if (!detached) return { nodes, applied: false, error: "That step is not in this suite." };
  const parent = findOnce(detached.nodes, frameId);
  if (!parent || !isFrame(parent)) return { nodes, applied: false, error: "That frame is not in this suite." };
  parent.children = [detached.removed, ...(parent.children ?? [])];
  if (oldParent !== frameId) delete detached.removed.layout;
  return { nodes: detached.nodes, applied: true };
}

/** Drop a step into a frame as its last step. */
export function nestInFrame(nodes: SuiteNode[], frameId: string, nodeId: string): GraphEdit {
  if (frameId === nodeId) return { nodes, applied: false, error: "A frame cannot contain itself." };
  const frame = findOnce(nodes, frameId);
  const node = findOnce(nodes, nodeId);
  if (!frame || !node) return { nodes, applied: false, error: "That step is not in this suite." };
  if (!isFrame(frame)) return { nodes, applied: false, error: "Drop a step onto a group or a loop." };
  if (containsNode(node, frameId)) {
    return { nodes, applied: false, error: "That would place a frame inside a step it already holds." };
  }
  if (parentIdOf(nodes, nodeId) === frameId) return { nodes, applied: false };
  const detached = detach(nodes, nodeId);
  if (!detached) return { nodes, applied: false, error: "That step is not in this suite." };
  const parent = findOnce(detached.nodes, frameId);
  if (!parent || !isFrame(parent)) return { nodes, applied: false, error: "That frame is not in this suite." };
  parent.children = [...(parent.children ?? []), detached.removed];
  delete detached.removed.layout;
  return { nodes: detached.nodes, applied: true };
}

/** Lift a nested step back to the end of the suite. */
export function liftToRoot(nodes: SuiteNode[], nodeId: string): GraphEdit {
  if (parentIdOf(nodes, nodeId) === null) return { nodes, applied: false };
  const detached = detach(nodes, nodeId);
  if (!detached) return { nodes, applied: false, error: "That step is not in this suite." };
  delete detached.removed.layout;
  detached.nodes.push(detached.removed);
  return { nodes: detached.nodes, applied: true };
}

/** Write `${variable}` into the target's arguments under the variable's name. */
export function connectData(nodes: SuiteNode[], sourceId: string, targetId: string): GraphEdit {
  const source = findOnce(nodes, sourceId);
  const target = findOnce(nodes, targetId);
  if (!source || !target) return { nodes, applied: false, error: "That step is not in this suite." };
  if (source.type !== "extractor") return { nodes, applied: false, error: "Data wires start from an extractor." };
  const variable = source.variable?.trim() ?? "";
  if (!safeVariable(variable)) {
    return { nodes, applied: false, error: "Name the extractor's variable before wiring it." };
  }
  if (sourceId === targetId) return { nodes, applied: false, error: "An extractor cannot feed itself." };
  if (referencesVariable(target, variable)) return { nodes, applied: false };
  const args = { ...(target.args ?? {}) };
  if (Object.prototype.hasOwnProperty.call(args, variable)) {
    return {
      nodes,
      applied: false,
      error: `Arguments already have "${variable}". Put \${${variable}} in the field that should receive the value.`,
    };
  }
  args[variable] = `\${${variable}}`;
  return { nodes: updateNode(nodes, targetId, { args }), applied: true };
}

/**
 * Remove the argument binding this wire created.
 * The wire stays when `${variable}` is still written somewhere on the step.
 */
export function disconnectData(nodes: SuiteNode[], sourceId: string, targetId: string): GraphEdit {
  const source = findOnce(nodes, sourceId);
  const target = findOnce(nodes, targetId);
  if (!source || !target) return { nodes, applied: false, error: "That step is not in this suite." };
  const variable = source.variable?.trim() ?? "";
  if (!safeVariable(variable)) return { nodes, applied: false, error: "That extractor has no variable." };
  const args = { ...(target.args ?? {}) };
  const bound = args[variable] === `\${${variable}}`;
  if (bound) delete args[variable];
  const next = bound ? updateNode(nodes, targetId, { args }) : nodes;
  const updated = findOnce(next, targetId);
  if (updated && referencesVariable(updated, variable)) {
    return {
      nodes: next,
      applied: bound,
      error: `The wire stays because \${${variable}} is still written on that step.`,
    };
  }
  if (!bound) {
    return { nodes, applied: false, error: "That wire is not an argument binding, so there is nothing to remove." };
  }
  return { nodes: next, applied: true };
}

export interface SuiteLayoutCard {
  id: string;
  type: SuiteNodeType;
  label: string;
  detail: string;
  x: number;
  y: number;
  width: number;
  height: number;
  frame: boolean;
  enabled: boolean;
}

export interface SuiteLayoutWire {
  kind: SuiteEdgeKind;
  source: string;
  target: string;
  variable?: string;
  d: string;
}

export interface SuiteLayout {
  width: number;
  height: number;
  cards: SuiteLayoutCard[];
  wires: SuiteLayoutWire[];
}

function cardDetail(node: SuiteNode, live: boolean): string {
  if (!node.enabled) return "Skipped when the suite runs";
  if (!live) return "Inside a disabled frame";
  if (node.type === "sampler") {
    const detail = node.tool || node.prompt || node.resourceUri;
    return detail ? `${node.method ?? "call"} · ${detail}` : (node.method ?? "Sampler");
  }
  if (node.type === "think") return `${node.thinkMs ?? 0} ms pause`;
  if (node.type === "extractor") {
    const variable = node.variable?.trim();
    return variable ? `\${${variable}} from ${node.path?.trim() || "the last response"}` : "Name a variable, then wire it";
  }
  if (node.type === "loop") return `${node.iterations ?? 1}× · ${(node.children ?? []).length} steps`;
  return `${(node.children ?? []).length} steps`;
}

function coord(value: number): string {
  return String(Math.round(value * 10) / 10);
}

function socket(card: SuiteLayoutCard, side: "in" | "out", kind: "flow" | "data"): GraphPoint {
  if (kind === "data") {
    const y = card.y + 78;
    const x = side === "out" ? card.x + card.width : card.x;
    return { x, y };
  }
  return {
    x: card.x + card.width / 2,
    y: side === "out" ? card.y + card.height : card.y,
  };
}

function horizontalCurve(from: GraphPoint, to: GraphPoint): string {
  if (Math.abs(to.y - from.y) < 6) {
    return `M ${coord(from.x)} ${coord(from.y)} L ${coord(to.x)} ${coord(to.y)}`;
  }
  const pull = Math.max(48, Math.abs(to.x - from.x) * 0.35);
  return `M ${coord(from.x)} ${coord(from.y)} C ${coord(from.x + pull)} ${coord(from.y)}, ${coord(to.x - pull)} ${coord(to.y)}, ${coord(to.x)} ${coord(to.y)}`;
}

function verticalCurve(from: GraphPoint, to: GraphPoint, wrapped: boolean): string {
  if (!wrapped && Math.abs(to.x - from.x) < 6 && to.y >= from.y) {
    return `M ${coord(from.x)} ${coord(from.y)} L ${coord(to.x)} ${coord(to.y)}`;
  }
  if (wrapped) {
    const side = Math.max(from.x, to.x) + 64;
    const mid = (from.y + to.y) / 2;
    return `M ${coord(from.x)} ${coord(from.y)} C ${coord(side)} ${coord(from.y)}, ${coord(side)} ${coord(mid)}, ${coord(side)} ${coord(mid)} S ${coord(to.x)} ${coord(to.y - 36)}, ${coord(to.x)} ${coord(to.y)}`;
  }
  const pull = Math.max(36, Math.abs(to.y - from.y) * 0.45);
  return `M ${coord(from.x)} ${coord(from.y)} C ${coord(from.x)} ${coord(from.y + pull)}, ${coord(to.x)} ${coord(to.y - pull)}, ${coord(to.x)} ${coord(to.y)}`;
}

function wirePath(edge: SuiteEdge, source: SuiteLayoutCard, target: SuiteLayoutCard): string {
  if (edge.kind === "entry") {
    const x = target.x + target.width / 2;
    return `M ${coord(x)} ${coord(source.y + 48)} L ${coord(x)} ${coord(target.y)}`;
  }
  if (edge.kind === "data") {
    return horizontalCurve(socket(source, "out", "data"), socket(target, "in", "data"));
  }
  const from = socket(source, "out", "flow");
  const to = socket(target, "in", "flow");
  return verticalCurve(from, to, to.y < from.y - 24);
}

function drawSuite(
  nodes: SuiteNode[],
  positions: Map<string, GraphPoint>,
  edges: SuiteEdge[] = deriveEdges(nodes),
): SuiteLayout {
  const live = liveNodeIds(nodes);
  const cards: SuiteLayoutCard[] = [];
  const boxes = new Map<string, SuiteLayoutCard>();
  const walk = (list: SuiteNode[], origin: GraphPoint) => {
    for (const node of list) {
      const local = positions.get(node.id) ?? { x: 0, y: 0 };
      const size = blockSize(node, positions);
      const card: SuiteLayoutCard = {
        id: node.id,
        type: node.type,
        label: node.label?.trim() || node.tool || node.method || node.type,
        detail: cardDetail(node, live.has(node.id)),
        x: origin.x + local.x,
        y: origin.y + local.y,
        width: size.width,
        height: size.height,
        frame: isFrame(node),
        enabled: live.has(node.id),
      };
      cards.push(card);
      boxes.set(node.id, card);
      if (node.children?.length) walk(node.children, { x: card.x, y: card.y });
    }
  };
  walk(nodes, { x: 0, y: 0 });
  let wires = wireCards(edges, boxes);
  for (let pass = 0; pass < 2; pass += 1) {
    const box = layoutBounds(cards);
    const dx = -box.minX;
    const dy = -box.minY;
    if (!dx && !dy) break;
    for (const card of cards) {
      card.x += dx;
      card.y += dy;
    }
    wires = wireCards(edges, boxes);
  }
  const box = layoutBounds(cards);
  return {
    width: Math.max(360, box.maxX) + 24,
    height: Math.max(120, box.maxY) + 72,
    cards,
    wires,
  };
}

function wireCards(edges: SuiteEdge[], boxes: Map<string, SuiteLayoutCard>): SuiteLayoutWire[] {
  const wires: SuiteLayoutWire[] = [];
  for (const edge of edges) {
    const source = boxes.get(edge.source);
    const target = boxes.get(edge.target);
    if (!source || !target) continue;
    wires.push({
      kind: edge.kind,
      source: edge.source,
      target: edge.target,
      variable: edge.variable,
      d: wirePath(edge, source, target),
    });
  }
  return wires;
}

function layoutBounds(cards: SuiteLayoutCard[]): { minX: number; minY: number; maxX: number; maxY: number } {
  if (!cards.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = 0;
  let maxY = 0;
  for (const card of cards) {
    minX = Math.min(minX, card.x);
    minY = Math.min(minY, card.y);
    maxX = Math.max(maxX, card.x + card.width);
    maxY = Math.max(maxY, card.y + card.height);
  }
  return { minX, minY, maxX, maxY };
}

/** Cards and wires for the suite page and the dashboard. Both draw this graph. */
export function layoutSuite(nodes: SuiteNode[], lanes = DEFAULT_LANES): SuiteLayout {
  return drawSuite(nodes, resolvePositions(nodes, lanes), executionEdges(nodes));
}

/** Same drawing as {@link layoutSuite}. */
export function layoutSuiteFan(nodes: SuiteNode[], lanes = DEFAULT_LANES): SuiteLayout {
  return layoutSuite(nodes, lanes);
}
