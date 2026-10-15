import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as introspection from "../engine/core/suite-introspect.js";
import { applyAuthFlags, resolveTargetSecrets, storedSecretNames } from "./suite-auth.js";
import {
  assertParamsReady,
  captureLoadProfile,
  captureSuite,
  formatSuiteShow,
  mergeParamValues,
  parameterizeSuiteNodes,
  resolveSuiteParamValues,
  parseSuiteFile,
  runSavedSuite,
  writeSuiteDir,
  type SuiteFile,
} from "./suite-file.js";
import { buildDefaultSuiteNodes, type ServerSurface, type SuiteNode } from "../engine/core/suite-model.js";

function surface(): ServerSurface {
  return {
    capabilities: ["tools", "prompts"],
    tools: [
      {
        name: "echo",
        schemaHash: "a",
        writeLike: false,
        inputSchema: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
        },
      },
      {
        name: "delete_note",
        schemaHash: "b",
        writeLike: true,
        inputSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
      },
    ],
    resources: [],
    resourceTemplates: [],
    prompts: [{ name: "greet", arguments: [{ name: "name", required: true }] }],
  };
}

function findTool(nodes: SuiteNode[], name: string): SuiteNode | undefined {
  for (const node of nodes) {
    if (node.tool === name) return node;
    const child = node.children ? findTool(node.children, name) : undefined;
    if (child) return child;
  }
  return undefined;
}

function findPrompt(nodes: SuiteNode[], name: string): SuiteNode | undefined {
  for (const node of nodes) {
    if (node.prompt === name) return node;
    const child = node.children ? findPrompt(node.children, name) : undefined;
    if (child) return child;
  }
  return undefined;
}

describe("suite file", () => {
  it("saves inferred arguments as parameter examples and model prompts in the suite", async () => {
    const server = vi.spyOn(introspection, "introspectServer").mockResolvedValue(surface());
    vi.stubEnv("SWARM_LLM_API_KEY", "local");
    vi.stubEnv("SWARM_LLM_BASE_URL", "http://127.0.0.1:11434/v1");
    const model = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ args: { message: "inferred fixture" },
        positive: { prompt: "Repeat inferred fixture", assertions: ["Echo gets inferred fixture"] },
        negative: { prompt: "Say hello without tools", assertions: ["No tool is called"] },
      }) } }],
    }), { headers: { "content-type": "application/json" } }));
    try {
      const outDir = await mkdtemp(join(tmpdir(), "inferred-suite-"));
      const suite = await captureSuite({ target: { transport: "stdio", command: "unused" }, outDir, inference: true });
      expect(findTool(suite.nodes, "echo")?.args).toEqual({ message: "${message}" });
      expect(findTool(suite.nodes, "echo")?.evals?.[0]?.prompt).toBe("Repeat inferred fixture");
      expect(findTool(suite.nodes, "delete_note")?.enabled).toBe(false);
      expect(model).toHaveBeenCalledTimes(1);
      const params = JSON.parse(await readFile(join(outDir, "params.example.json"), "utf8"));
      expect(params.message).toBe("inferred fixture");
      expect(JSON.parse(await readFile(join(outDir, "suite.json"), "utf8")).nodes).toEqual(suite.nodes);
    } finally {
      server.mockRestore(); model.mockRestore(); vi.unstubAllEnvs();
    }
  });
  it("turns required strings into parameters and leaves write tools disabled", () => {
    const picture = surface();
    const { nodes, params } = parameterizeSuiteNodes(buildDefaultSuiteNodes(picture), picture);
    const echo = findTool(nodes, "echo");
    const deleted = findTool(nodes, "delete_note");
    const greet = findPrompt(nodes, "greet");
    expect(echo?.enabled).toBe(true);
    expect(echo?.args).toEqual({ message: "${message}" });
    expect(params.message?.example).toBe("swarm-record-fixture");
    expect(params.message?.usedBy).toContain(echo?.id);
    expect(deleted?.enabled).toBe(false);
    expect(deleted?.args).toEqual({ id: "fixture" });
    expect(params.id).toBeUndefined();
    expect(greet?.args).toEqual({ name: "${name}" });
    expect(params.name?.example).toBe("fixture");
  });

  it("loads every captured parameter by default and applies overrides in order", async () => {
    const dir = await mkdtemp(join(tmpdir(), "suite-defaults-"));
    const suite = { params: {
      code: { example: "return 42", usedBy: ["code-step"] },
      language: { example: "python", usedBy: ["docs-step"] },
      query: { example: "authentication", usedBy: ["docs-step"] },
    } } as unknown as SuiteFile;
    expect(await resolveSuiteParamValues(dir, suite)).toEqual({ code: "return 42", language: "python", query: "authentication" });
    await writeFile(join(dir, "params.example.json"), JSON.stringify({ query: "rate limits" }));
    expect(await resolveSuiteParamValues(dir, suite, { language: "typescript" })).toEqual({ code: "return 42", language: "typescript", query: "rate limits" });
  });

  it("gives colliding argument names distinct parameters", () => {
    const picture: ServerSurface = {
      capabilities: ["tools"],
      tools: [
        { name: "one", schemaHash: "1", writeLike: false, inputSchema: { required: ["message"] } },
        { name: "two", schemaHash: "2", writeLike: false, inputSchema: { required: ["message"] } },
      ],
      resources: [],
      resourceTemplates: [],
      prompts: [],
    };
    const nodes: SuiteNode[] = [
      { id: "a", type: "sampler", enabled: true, method: "tools/call", tool: "one", args: { message: "alpha" } },
      { id: "b", type: "sampler", enabled: true, method: "tools/call", tool: "two", args: { message: "beta" } },
    ];
    const parameterized = parameterizeSuiteNodes(nodes, picture);
    expect(parameterized.params.one_message?.example).toBe("alpha");
    expect(parameterized.params.two_message?.example).toBe("beta");
    expect(parameterized.nodes[0]?.args).toEqual({ message: "${one_message}" });
    expect(parameterized.nodes[1]?.args).toEqual({ message: "${two_message}" });
  });

  it("keeps a bearer token out of the connection until the environment supplies it", async () => {
    const parsed = parseSuiteFile({
      kind: "botz-suite",
      name: "remote",
      target: {
        transport: "streamable-http",
        url: "http://127.0.0.1:9/mcp",
        headers: { Authorization: "Bearer ${env:MCP_SUITE_TOKEN}" },
      },
      surface: { capabilities: [], tools: [] },
      nodes: [],
      load: captureLoadProfile(),
      params: {},
    });
    expect(parsed.target).toMatchObject({
      headers: { Authorization: "Bearer ${env:MCP_SUITE_TOKEN}" },
    });

    const dir = await mkdtemp(join(tmpdir(), "suite-missing-"));
    const suite: SuiteFile = {
      kind: "botz-suite",
      capturedAt: new Date().toISOString(),
      name: "remote",
      target: { transport: "streamable-http", url: "http://127.0.0.1:9/mcp" },
      surface: { capabilities: [], tools: [], resources: [], resourceTemplates: [], prompts: [] },
      nodes: [
        {
          id: "call",
          type: "sampler",
          enabled: true,
          method: "tools/call",
          tool: "echo",
          args: { message: "${city}" },
        },
      ],
      load: captureLoadProfile(),
      params: { city: { example: "NYC", usedBy: ["call"] } },
    };
    await writeSuiteDir(dir, suite);
    expect(await resolveSuiteParamValues(dir, suite)).toEqual({ city: "NYC" });
    expect(() => assertParamsReady(suite, {})).toThrow(/missing parameter: city/);
    const authed = join(dir, "authed");
    await writeSuiteDir(authed, {
      ...suite,
      target: {
        transport: "streamable-http",
        url: "http://127.0.0.1:9/mcp",
        headers: { Authorization: "Bearer ${env:MCP_SUITE_TOKEN_MISSING}" },
      },
    });
    const previous = process.env.MCP_SUITE_TOKEN_MISSING;
    delete process.env.MCP_SUITE_TOKEN_MISSING;
    try {
      await expect(runSavedSuite(authed, {
        params: { city: "NYC" },
        outputDir: join(dir, "authed-out"),
      })).rejects.toThrow(/missing credential: MCP_SUITE_TOKEN_MISSING/);
    } finally {
      if (previous !== undefined) process.env.MCP_SUITE_TOKEN_MISSING = previous;
    }
    const undeclared: SuiteFile = {
      ...suite,
      nodes: [
        {
          id: "call",
          type: "sampler",
          enabled: true,
          method: "tools/call",
          tool: "echo",
          args: { message: "${extra}" },
        },
      ],
    };
    expect(() => assertParamsReady(undeclared, { city: "SFO" })).toThrow(/unknown parameter: extra/);
    expect(() => assertParamsReady({ ...undeclared, nodes: undeclared.nodes.map((node) => ({ ...node, enabled: false })) }, { city: "SFO" })).not.toThrow();
  });

  it("refuses URL credentials it cannot store safely before connecting", async () => {
    const dir = await mkdtemp(join(tmpdir(), "suite-url-creds-"));
    const key = "k" + "ey-Ab12Cd34";
    await expect(captureSuite({
      target: { transport: "streamable-http", url: `http://127.0.0.1:9/mcp?api_key=${key}` },
      outDir: join(dir, "a"),
      auth: { bearerEnv: "MCP_TOKEN", urlKeyAsBearer: true },
    })).rejects.toThrow(/Authorization header is also set/);
    await expect(captureSuite({
      target: { transport: "streamable-http", url: `http://127.0.0.1:9/mcp?api_key=${key}` },
      outDir: join(dir, "b"),
      auth: { header: ["Authorization: Bearer other"], urlKeyAsBearer: true },
    })).rejects.toThrow(/Authorization header is also set/);
    await expect(captureSuite({
      target: { transport: "streamable-http", url: "http://" + "u1:" + key + "@127.0.0.1:9/mcp" },
      outDir: join(dir, "c"),
    })).rejects.toThrow(/--bearer-env or --header/);
    await expect(captureSuite({
      target: { transport: "streamable-http", url: `http://127.0.0.1:9/mcp?private_key=${key}` },
      outDir: join(dir, "d"),
    })).rejects.toThrow(/query parameter private_key looks like a credential/);
    await expect(captureSuite({
      target: { transport: "streamable-http", url: `http://127.0.0.1:9/mcp#access_token=${key}` },
      outDir: join(dir, "e"),
    })).rejects.toThrow(/fragment holds a credential/);
  });

  it("merges a parameter file with --set and prints the suite offline", () => {
    const values = mergeParamValues({ city: "NYC", limit: "1" }, ["city=SFO", "note=hi=there"]);
    expect(values).toEqual({ city: "SFO", limit: "1", note: "hi=there" });
    const suite: SuiteFile = {
      kind: "botz-suite",
      capturedAt: "2026-10-08T00:00:00.000Z",
      name: "demo",
      target: { transport: "streamable-http", url: "http://127.0.0.1:3000/mcp" },
      surface: { capabilities: [], tools: [], resources: [], resourceTemplates: [], prompts: [] },
      nodes: [
        { id: "off", type: "sampler", enabled: false, method: "tools/call", tool: "delete_note", label: "delete_note" },
        { id: "on", type: "sampler", enabled: true, method: "tools/call", tool: "echo", label: "echo" },
      ],
      load: captureLoadProfile(),
      params: { city: { example: "NYC", usedBy: ["on"] } },
    };
    const authed = applyAuthFlags(
      { transport: "streamable-http", url: "http://127.0.0.1:3000/mcp" },
      { bearerEnv: "MCP_TOKEN", header: ["X-Api-Key: literal-secret"] },
    );
    expect(authed).toMatchObject({
      headers: {
        Authorization: "Bearer ${env:MCP_TOKEN}",
        "X-Api-Key": "literal-secret",
      },
    });
    expect(resolveTargetSecrets(authed, { MCP_TOKEN: "sekret" })).toMatchObject({
      headers: { Authorization: "Bearer sekret", "X-Api-Key": "literal-secret" },
    });
    expect(storedSecretNames(authed)).toEqual(["X-Api-Key"]);
    expect(formatSuiteShow({ ...suite, target: authed })).toContain("Authorization: Bearer ${env:MCP_TOKEN}");
    expect(formatSuiteShow({ ...suite, target: authed })).toContain("X-Api-Key: [REDACTED]");
    expect(formatSuiteShow({ ...suite, target: authed })).not.toContain("literal-secret");

    expect(formatSuiteShow(suite)).toBe(
      [
        "demo",
        "target: streamable-http http://127.0.0.1:3000/mcp",
        "",
        "steps:",
        "  echo",
        "",
        "parameters:",
        "  city",
      ].join("\n"),
    );
  });
});


it("protects edits on re-capture and scopes same-name credentials by identity", async () => {
  const server = vi.spyOn(introspection, "introspectServer").mockResolvedValue(surface());
  try {
    const root = await mkdtemp(join(tmpdir(), "recapture-"));
    const input = { target: { transport: "stdio" as const, command: "fixture" }, name: "same", inference: false };
    const a = await captureSuite({ ...input, outDir: join(root, "a") });
    const b = await captureSuite({ ...input, outDir: join(root, "b") });
    expect(a.id).not.toBe(b.id);
    await writeFile(join(root, "a", "params.example.json"), '{"message":"edited"}');
    await expect(captureSuite({ ...input, outDir: join(root, "a") })).rejects.toThrow(/--force/);
    expect(await readFile(join(root, "a", "params.example.json"), "utf8")).toContain("edited");
    const replaced = await captureSuite({ ...input, outDir: join(root, "a"), force: true });
    expect(replaced.id).toBe(a.id);
  } finally { server.mockRestore(); }
});

it("rejects unsupported versions, malformed nested nodes, and duplicate IDs before execution", () => {
  const valid = { kind: "botz-suite", name: "test", target: { transport: "stdio", command: "node" },
    surface: surface(), nodes: [{ id: "a", type: "sampler", enabled: true, method: "ping" }], params: {}, load: {} };
  expect(parseSuiteFile(valid).schemaVersion).toBe(1);
  expect(() => parseSuiteFile({ ...valid, schemaVersion: 3 })).toThrow(/schemaVersion/);
  expect(() => parseSuiteFile({ ...valid, nodes: [{ id: "g", type: "group", enabled: true, children: [null] }] })).toThrow();
  expect(() => parseSuiteFile({ ...valid, nodes: [...valid.nodes, ...valid.nodes] })).toThrow(/duplicate node id/);
});
