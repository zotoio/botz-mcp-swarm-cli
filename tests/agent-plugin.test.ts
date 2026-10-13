import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { inspectAgentPlugin } from "../scripts/check-agent-plugin.mjs";
const root = fileURLToPath(new URL("..", import.meta.url));
function assets(path = join(root, "agent-plugin"), prefix = "agent-plugin"): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory()) for (const [key, value] of assets(join(path, entry.name), `${prefix}/${entry.name}`)) files.set(key, value);
    else files.set(`${prefix}/${entry.name}`, readFileSync(join(path, entry.name)));
  }
  return files;
}
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
describe("portable release assets", () => {
  it("validates complete skill and marketplace bundles", () => expect(inspectAgentPlugin(assets(), version)).toEqual([]));
  it("rejects missing assets and version drift", () => {
    const files = assets(); files.delete("agent-plugin/.claude-plugin/plugin.json");
    expect(inspectAgentPlugin(files, "999.0.0").length).toBeGreaterThan(0);
  });
  it("rejects nonportable fields and invalid skill names", () => {
    const files = assets();
    files.set("agent-plugin/skills/mcp-swarm/SKILL.md", Buffer.from("---\nname: Wrong_Name\ndescription: example\nuser-invocable: false\n---\n"));
    expect(inspectAgentPlugin(files, version).length).toBeGreaterThan(0);
  });
  it("accepts only a boolean disable-model-invocation", () => {
    const skill = (value: string) => Buffer.from(`---\nname: mcp-swarm\ndescription: example\ndisable-model-invocation: ${value}\n---\n`);
    const files = assets();
    files.set("agent-plugin/skills/mcp-swarm/SKILL.md", skill("false"));
    expect(inspectAgentPlugin(files, version)).toEqual([]);
    files.set("agent-plugin/skills/mcp-swarm/SKILL.md", skill('"true"'));
    expect(inspectAgentPlugin(files, version)).toEqual(["agent-plugin/skills/mcp-swarm/SKILL.md: disable-model-invocation must be true or false"]);
  });
});
