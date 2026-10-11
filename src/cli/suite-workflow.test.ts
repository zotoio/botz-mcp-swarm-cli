import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureLoadProfile, captureSuite, resolveSuiteExecution, writeSuiteDir, type SuiteFile } from "./suite-file.js";
import { refreshSavedSuite, refreshSuiteModel } from "./suite-refresh.js";
import { diagnosticError } from "./diagnostic-error.js";
import { formatJUnit } from "./run-output.js";
import { integer } from "./run-commands.js";
import * as introspection from "../engine/core/suite-introspect.js";
import { buildDefaultSuiteNodes, type ServerSurface } from "../engine/core/suite-model.js";
import type { RunReport } from "../engine/types/run.js";

const surface: ServerSurface = { capabilities: ["tools"], tools: [{ name: "echo", schemaHash: "v1", writeLike: false }], resources: [], prompts: [], resourceTemplates: [] };
const fixture = (): SuiteFile => ({ kind: "botz-suite", name: "demo", capturedAt: "2026-01-01", target: { transport: "streamable-http", url: "https://production.example/mcp", headers: { Authorization: "Bearer ${env:PRODUCTION_TOKEN}" } }, surface, nodes: buildDefaultSuiteNodes(surface), load: captureLoadProfile(), params: {} });
const dirs: string[] = [];
async function setup(suite = fixture()) { const dir = await mkdtemp(join(tmpdir(), "suite-workflow-")); dirs.push(dir); await writeSuiteDir(dir, suite); return dir; }
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("standalone workflow", () => {
  it("captures without contacting a model by default", async () => {
    vi.spyOn(introspection, "introspectServer").mockResolvedValue(surface);
    const model = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("model must not be called"));
    const dir = await mkdtemp(join(tmpdir(), "capture-default-")); dirs.push(dir);
    await captureSuite({ target: { transport: "stdio", command: "fixture" }, outDir: dir });
    expect(model).not.toHaveBeenCalled();
  });
  it("replaces endpoints without inheriting captured credentials and resolves explicit credentials", async () => {
    vi.stubEnv("PRODUCTION_TOKEN", "production-secret"); vi.stubEnv("STAGING_TOKEN", "staging-secret");
    const dir = await setup();
    const original = await readFile(join(dir, "suite.json"), "utf8");
    const plan = await resolveSuiteExecution(dir, { url: "https://staging.example/mcp", auth: { bearerEnv: "STAGING_TOKEN" }, load: { durationMs: 200, rampUpMs: 10, maxConcurrency: 3 } });
    expect(plan.target).toEqual({ transport: "streamable-http", url: "https://staging.example/mcp", headers: { Authorization: "Bearer staging-secret" } });
    expect((await resolveSuiteExecution(dir, { url: "https://staging.example/mcp" })).target).not.toHaveProperty("headers");
    expect(plan.manifest.load).toMatchObject({ durationMs: 200, rampUpMs: 10, maxConcurrency: 3 });
    expect(await readFile(join(dir, "suite.json"), "utf8")).toBe(original);
    await expect(resolveSuiteExecution(dir, { load: { maxConcurrency: 0 } })).rejects.toThrow();
  });
  it("reports missing credential names while offline validation can omit secret resolution", async () => {
    vi.stubEnv("PRODUCTION_TOKEN", "");
    const dir = await setup();
    await expect(resolveSuiteExecution(dir, { resolveSecrets: false })).resolves.toBeDefined();
    try { await resolveSuiteExecution(dir); throw new Error("unexpected success"); }
    catch (error) { expect(diagnosticError(error)).toEqual({ code: "MISSING_CREDENTIAL", detail: "missing credential: PRODUCTION_TOKEN" }); }
    const raw = fixture() as unknown as { nodes: unknown[] };
    raw.nodes = [{ id: "secret-value", type: "bad-secret", enabled: true }];
    await writeFile(join(dir, "suite.json"), JSON.stringify(raw));
    try { await resolveSuiteExecution(dir); throw new Error("unexpected success"); }
    catch (error) {
      const message = JSON.stringify(diagnosticError(error));
      expect(message).toContain("nodes.0.type"); expect(message).not.toContain("bad-secret");
    }
  });
  it("refresh preserves nested custom nodes and parameters, disables removed tools, and adds safe defaults", () => {
    const suite = fixture();
    const node = suite.nodes[0]!.children!.find((node) => node.tool === "echo")!;
    node.args = { message: "${custom}" }; node.expect = { resultShape: "tools/call", outputSchema: { type: "object", required: ["custom"] } };
    suite.params = { custom: { example: "edited", usedBy: [node.id] } };
    const next = { ...surface, tools: [{ name: "new_tool", schemaHash: "v1", writeLike: false }, { name: "delete_record", schemaHash: "v1", writeLike: true }] };
    const refreshed = refreshSuiteModel(suite, next);
    const children = refreshed.suite.nodes[0]!.children!;
    expect(children.find((item) => item.id === node.id)).toEqual({ ...node, enabled: false });
    expect(refreshed.suite.params).toEqual(suite.params);
    expect(children.find((item) => item.tool === "delete_record")?.enabled).toBe(false);
    expect(refreshed.changes.removed).toContain("tool:echo");
    expect(children.at(-1)?.method).toBe("teardown");
    expect(refreshSuiteModel(refreshed.suite, next).changes.addedNodes).toEqual([]);
  });
  it("refresh dry-run is read-only and applying schema changes preserves assertions and example files", async () => {
    const suite = fixture(); delete (suite.target as { headers?: unknown }).headers;
    const dir = await setup(suite);
    await writeFile(join(dir, "params.example.json"), '{"custom":"user-edited"}');
    const original = await readFile(join(dir, "suite.json"), "utf8");
    vi.spyOn(introspection, "introspectServer").mockResolvedValue({ ...surface, tools: [{ ...surface.tools[0]!, schemaHash: "v2" }] });
    expect((await refreshSavedSuite(dir, { dryRun: true })).changes.changed).toEqual(["tool:echo"]);
    expect(await readFile(join(dir, "suite.json"), "utf8")).toBe(original);
    const result = await refreshSavedSuite(dir);
    expect(result.suite.nodes).toEqual(suite.nodes);
    expect(await readFile(join(dir, "params.example.json"), "utf8")).toBe('{"custom":"user-edited"}');
  });
  it("refresh refuses to overwrite edits made while discovery was running", async () => {
    const suite = fixture(); delete (suite.target as { headers?: unknown }).headers;
    const dir = await setup(suite);
    vi.spyOn(introspection, "introspectServer").mockImplementation(async () => { await writeFile(join(dir, "suite.json"), "concurrent edit"); return surface; });
    await expect(refreshSavedSuite(dir)).rejects.toThrow("suite changed during discovery");
    expect(await readFile(join(dir, "suite.json"), "utf8")).toBe("concurrent edit");
  });
  it("JUnit escapes XML and includes aggregate verdict failures", () => {
    const report = { manifestName: 'demo<&"', durationMs: 50, verdict: "fail", scenarioOutcomes: [{ scenario: "passing step", outcome: "pass" }], failReasons: ["latency > threshold & SLO"] } as RunReport;
    const xml = formatJUnit(report);
    expect(xml).toContain('failures="1"'); expect(xml).toContain('tests="2"');
    expect(xml).toContain("demo&lt;&amp;&quot;"); expect(xml).toContain("latency &gt; threshold &amp; SLO");
  });
  it("rejects malformed and out-of-range load flags before connecting", () => {
    for (const value of ["2users", "1.5", "-1", "Infinity", "9007199254740992"]) expect(() => integer(value, "concurrency", 1)).toThrow();
    expect(() => integer("0", "concurrency", 1)).toThrow(); expect(integer("0", "duration")).toBe(0);
  });
});
