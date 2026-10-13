import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Validate the deliberately small, single-line YAML subset used by our portable skills. */
export function inspectAgentPlugin(files, version) {
  const errors = [];
  const read = name => {
    const value = files.get(`agent-plugin/${name}`);
    if (value === undefined) { errors.push(`missing ${name}`); return ""; }
    return value.toString();
  };
  for (const path of ["plugin.json", ".cursor-plugin/plugin.json", ".claude-plugin/plugin.json"]) {
    try {
      const manifest = JSON.parse(read(path));
      if (manifest.name !== "botz-mcp-swarm" || manifest.version !== version) errors.push(`${path}: name/version must match the CLI release`);
      if (path === "plugin.json") {
        if (manifest.$schema !== "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json") errors.push(`${path}: missing Agent Plugins schema`);
        const allowed = ["$schema", "name", "version", "description", "author", "homepage", "repository", "license", "keywords", "extensions"];
        if (Object.keys(manifest).some(key => !allowed.includes(key))) errors.push(`${path}: unsupported portable manifest field`);
      }
    } catch { errors.push(`${path}: invalid JSON`); }
  }
  read("LICENSE"); read("README.md");
  for (const path of ["marketplace-entry.json", "marketplace-entry.openai.json"]) {
    try {
      const entry = JSON.parse(read(path));
      const source = typeof entry.source === "string" ? entry.source : entry.source?.path;
      if (entry.name !== "botz-mcp-swarm" || source !== "./plugins/botz-mcp-swarm") errors.push(`${path}: invalid monorepo entry`);
    } catch { errors.push(`${path}: invalid JSON`); }
  }
  const skills = [...files.keys()].filter(path => /^agent-plugin\/skills\/[^/]+\/SKILL\.md$/.test(path));
  if (!skills.length) errors.push("no bundled skills");
  for (const path of skills) {
    const text = files.get(path).toString();
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
    if (!frontmatter) { errors.push(`${path}: missing YAML frontmatter`); continue; }
    const fields = {};
    let metadata = false;
    const metadataKeys = new Set();
    const scalar = raw => {
      if (raw.startsWith('"')) return JSON.parse(raw);
      if (/[:\[\]{}#]|^(?:true|false|null|~|\d)/.test(raw)) throw new Error("quote non-plain YAML strings");
      return raw;
    };
    try {
      for (const line of frontmatter.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const match = /^( *)([a-z][a-z0-9-]*):(?: (.*))?$/.exec(line);
        if (!match) throw new Error("expected single-line YAML mapping");
        const [, indent, key, raw = ""] = match;
        if (indent) {
          if (!metadata || indent !== "  " || metadataKeys.has(key) || typeof scalar(raw) !== "string") throw new Error("metadata must map unique string keys to strings");
          metadataKeys.add(key);
        } else {
          if (Object.hasOwn(fields, key)) throw new Error("duplicate frontmatter key");
          metadata = key === "metadata";
          if (metadata && raw) throw new Error("expected metadata mapping");
          // Claude Code and Cursor read this boolean; other clients ignore it.
          if (key === "disable-model-invocation") {
            if (raw !== "true" && raw !== "false") throw new Error("disable-model-invocation must be true or false");
            fields[key] = raw === "true";
          } else fields[key] = metadata ? {} : scalar(raw);
        }
      }
      const allowed = ["name", "description", "license", "compatibility", "metadata", "allowed-tools", "disable-model-invocation"];
      if (Object.keys(fields).some(key => !allowed.includes(key))) throw new Error("unsupported Agent Skills field");
      const name = path.split("/")[2];
      if (fields.name !== name || name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error("invalid skill name");
      if (typeof fields.description !== "string" || !fields.description.length || fields.description.length > 1024) throw new Error("description must have 1-1024 characters");
      if (fields.compatibility !== undefined && (typeof fields.compatibility !== "string" || !fields.compatibility.length || fields.compatibility.length > 500)) throw new Error("compatibility must have 1-500 characters");
      if (Object.entries(fields).some(([key, value]) => key !== "metadata" && key !== "disable-model-invocation" && typeof value !== "string")) throw new Error("frontmatter values must be strings");
    } catch (error) { errors.push(`${path}: ${error.message}`); }
  }
  return errors;
}

function collect(root, prefix = "agent-plugin") {
  const result = new Map();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) for (const pair of collect(join(root, entry.name), `${prefix}/${entry.name}`)) result.set(...pair);
    else if (entry.isFile()) result.set(`${prefix}/${entry.name}`, readFileSync(join(root, entry.name)));
    else throw new Error(`non-regular plugin asset: ${entry.name}`);
  }
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const errors = inspectAgentPlugin(collect(join(root, "agent-plugin")), JSON.parse(readFileSync(join(root, "package.json"))).version);
  if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; }
  else console.log("Agent Skills and plugin release assets: OK");
}
