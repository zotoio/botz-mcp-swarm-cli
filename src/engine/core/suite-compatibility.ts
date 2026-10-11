import {
  buildDefaultSuiteNodes,
  isWriteToolName,
  toolIsCalledByDefault,
  type ServerSurface,
  type SuiteNode,
  type ToolCatalogEntry,
} from "./suite-model.js";

export interface SuiteCompatibility {
  compatible: boolean;
  missing: string[];
  extra: string[];
  schemaChanged: string[];
}

function slot(node: SuiteNode): string | null {
  if (node.type !== "sampler" || !node.method) return null;
  if (node.method === "tools/call") return `tools/call:${node.tool ?? ""}`;
  if (node.method === "resources/read") return `resources/read:${node.resourceUri ?? ""}`;
  if (node.method === "prompts/get") return `prompts/get:${node.prompt ?? ""}`;
  return node.method;
}

function enabledSamplers(nodes: SuiteNode[], out: SuiteNode[] = []): SuiteNode[] {
  for (const node of nodes) {
    if (!node.enabled) continue;
    if (node.type === "sampler") out.push(node);
    if (node.children?.length) enabledSamplers(node.children, out);
  }
  return out;
}

/**
 * Compare a saved suite with the suite introspection would generate now.
 * Disabled destructive tools are not required. An enabled call the server
 * no longer advertises is extra. A schema hash change on a called tool is incompatible.
 */
export function compareSuiteToSurface(
  nodes: SuiteNode[],
  previousCatalog: ToolCatalogEntry[],
  surface: ServerSurface,
): SuiteCompatibility {
  const expected = new Set(
    enabledSamplers(buildDefaultSuiteNodes(surface)).map(slot).filter((value): value is string => Boolean(value)),
  );
  const actualNodes = enabledSamplers(nodes);
  const actual = new Set(actualNodes.map(slot).filter((value): value is string => Boolean(value)));
  const missing = [...expected].filter((item) => !actual.has(item)).sort();
  const knownTools = new Set(surface.tools.map((tool) => tool.name));
  const knownResources = new Set(surface.resources.map((resource) => resource.uri));
  const knownPrompts = new Set(surface.prompts.map((prompt) => prompt.name));
  const extra: string[] = [];
  for (const node of actualNodes) {
    const key = slot(node);
    if (!key) continue;
    if (node.method === "tools/call" && node.tool && !knownTools.has(node.tool)) extra.push(key);
    else if (node.method === "resources/read" && node.resourceUri && !knownResources.has(node.resourceUri)) extra.push(key);
    else if (node.method === "prompts/get" && node.prompt && !knownPrompts.has(node.prompt)) extra.push(key);
  }
  const previous = new Map(previousCatalog.map((tool) => [tool.name, tool.schemaHash]));
  const schemaChanged: string[] = [];
  for (const tool of surface.tools) {
    const prior = previous.get(tool.name);
    if (!prior || prior === tool.schemaHash) continue;
    const called = actualNodes.some((node) => node.method === "tools/call" && node.tool === tool.name);
    if (called || toolIsCalledByDefault(tool)) schemaChanged.push(tool.name);
  }
  schemaChanged.sort();
  return {
    compatible: missing.length === 0 && extra.length === 0 && schemaChanged.length === 0,
    missing,
    extra: [...new Set(extra)].sort(),
    schemaChanged,
  };
}

export function suiteEnablesDestructive(nodes: SuiteNode[], catalog: ToolCatalogEntry[]): boolean {
  const tools = new Map(catalog.map((tool) => [tool.name, tool]));
  const walk = (list: SuiteNode[]): boolean => {
    for (const node of list) {
      if (!node.enabled) continue;
      if (node.method === "tools/call" && node.tool) {
        const tool = tools.get(node.tool);
        if (tool ? !toolIsCalledByDefault(tool) : isWriteToolName(node.tool)) return true;
      }
      if (node.children && walk(node.children)) return true;
    }
    return false;
  };
  return walk(nodes);
}
