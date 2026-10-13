import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveBotzHome } from "./botz-home.js";
import { applyUpgrade, MIGRATIONS, planUpgrade } from "./upgrade.js";

let root = "";
let repo = "";
let home = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "botz-upgrade-"));
  repo = join(root, "repo");
  home = join(root, "home");
  await mkdir(join(repo, ".git"), { recursive: true });
  await mkdir(home, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function legacyRepo(): Promise<void> {
  await mkdir(join(repo, ".botz", "suites", "demo"), { recursive: true });
  await writeFile(join(repo, ".botz", "suites", "demo", "suite.json"), "{}");
  await writeFile(join(repo, ".botz", "config.json"), JSON.stringify({ suites: { demo: { credentials: { A: "old", B: "old" } } } }));
  await writeFile(join(repo, ".botz", "skill-installations.json"), "{}");
  await mkdir(join(repo, ".runs", "ci-soak"), { recursive: true });
  await writeFile(join(repo, ".runs", "r1.json"), "{}");
  await writeFile(join(repo, "botz-run-2026-01-01T00-00-00-000Z.json"), "{}");
  await mkdir(join(repo, ".swarm-data", "projects"), { recursive: true });
  await writeFile(join(repo, ".swarm-data", "policy.json"), "{}");
  await mkdir(join(repo, ".otel"), { recursive: true });
}

describe("upgrade", () => {
  it("lists migrations in release order with unique ids", () => {
    const ids = MIGRATIONS.map((migration) => migration.id);
    expect(new Set(ids).size).toBe(ids.length);
    const versions = MIGRATIONS.map((migration) => migration.since.split(".").map(Number));
    for (let i = 1; i < versions.length; i++) {
      const [a, b] = [versions[i - 1]!, versions[i]!];
      expect(a[0]! * 1e6 + a[1]! * 1e3 + a[2]!).toBeLessThanOrEqual(b[0]! * 1e6 + b[1]! * 1e3 + b[2]!);
    }
  });

  it("previews without touching files, then moves everything into .botz/mcp-swarm", async () => {
    await legacyRepo();
    const botz = resolveBotzHome({ cwd: repo, home });
    const planned = await planUpgrade(botz);
    expect(planned.every((action) => action.state === "pending")).toBe(true);
    expect(planned.map((action) => `${action.step}:${action.from}->${action.to}`)).toEqual([
      "legacy-suites:.botz/suites/demo->.botz/mcp-swarm/suites/demo",
      "legacy-credentials:.botz/config.json->.botz/mcp-swarm/config.json",
      "legacy-skill-registry:.botz/skill-installations.json->.botz/mcp-swarm/skill-installations.json",
      "legacy-reports:.runs/ci-soak->.botz/mcp-swarm/runs/ci-soak",
      "legacy-reports:.runs/r1.json->.botz/mcp-swarm/runs/r1.json",
      "legacy-reports:botz-run-2026-01-01T00-00-00-000Z.json->.botz/mcp-swarm/runs/botz-run-2026-01-01T00-00-00-000Z.json",
      "service-state:.swarm-data->.botz/mcp-swarm/data",
      "service-state:.otel->.botz/mcp-swarm/otel",
    ]);
    expect(planned.some((action) => JSON.stringify({ ...action, source: undefined, target: undefined }).includes(root))).toBe(false);
    expect(existsSync(join(repo, ".swarm-data"))).toBe(true);

    await applyUpgrade(botz, planned);
    const swarm = join(repo, ".botz", "mcp-swarm");
    for (const path of ["suites/demo/suite.json", "skill-installations.json", "runs/ci-soak", "runs/r1.json", "data/policy.json", "otel", ".gitignore"]) {
      expect(existsSync(join(swarm, path)), path).toBe(true);
    }
    for (const path of [".botz/suites", ".botz/config.json", ".runs", ".swarm-data", ".otel", "botz-run-2026-01-01T00-00-00-000Z.json"]) {
      expect(existsSync(join(repo, path)), path).toBe(false);
    }
    expect(await planUpgrade(resolveBotzHome({ cwd: repo, home }))).toEqual([]);
  });

  it("merges legacy credentials without overwriting newer values and keeps owner-only access", async () => {
    await legacyRepo();
    await mkdir(join(repo, ".botz", "mcp-swarm"), { recursive: true });
    await writeFile(join(repo, ".botz", "mcp-swarm", "config.json"), JSON.stringify({ suites: { demo: { credentials: { A: "new" } }, other: { credentials: { C: "new" } } } }));
    const botz = resolveBotzHome({ cwd: repo, home });
    const planned = await planUpgrade(botz);
    expect(planned.find((action) => action.step === "legacy-credentials")).toMatchObject({ kind: "merge", state: "pending" });
    expect(planned.find((action) => action.step === "legacy-credentials")?.reason).toBeUndefined();
    await applyUpgrade(botz, planned);
    const path = join(repo, ".botz", "mcp-swarm", "config.json");
    expect(JSON.parse(await readFile(path, "utf8")).suites).toEqual({
      demo: { credentials: { A: "new", B: "old" } },
      other: { credentials: { C: "new" } },
    });
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("reports a conflict and leaves both copies when the target exists", async () => {
    await legacyRepo();
    await mkdir(join(repo, ".botz", "mcp-swarm", "suites", "demo"), { recursive: true });
    await writeFile(join(repo, ".botz", "mcp-swarm", "suites", "demo", "suite.json"), '{"new":true}');
    const botz = resolveBotzHome({ cwd: repo, home });
    const planned = await applyUpgrade(botz, await planUpgrade(botz));
    expect(planned.find((action) => action.step === "legacy-suites")).toMatchObject({ state: "conflict" });
    expect(await readFile(join(repo, ".botz", "suites", "demo", "suite.json"), "utf8")).toBe("{}");
    expect(await readFile(join(repo, ".botz", "mcp-swarm", "suites", "demo", "suite.json"), "utf8")).toBe('{"new":true}');
    expect(planned.filter((action) => action.step !== "legacy-suites").every((action) => action.state === "applied")).toBe(true);
  });

  it("outside a repo upgrades ~/.botz but scans only the cwd, never home, for reports and service state", async () => {
    const cwd = join(root, "work");
    await mkdir(join(home, ".botz", "suites", "solo"), { recursive: true });
    await writeFile(join(home, ".botz", "suites", "solo", "suite.json"), "{}");
    await mkdir(join(home, ".runs"), { recursive: true });
    await writeFile(join(home, ".runs", "unrelated.json"), "{}");
    await mkdir(join(cwd, ".swarm-data"), { recursive: true });
    const planned = await planUpgrade(resolveBotzHome({ cwd, home }));
    expect(planned.map((action) => `${action.from}->${action.to}`)).toEqual([
      "~/.botz/suites/solo->~/.botz/mcp-swarm/suites/solo",
      ".swarm-data->.botz/mcp-swarm/data",
    ]);
  });
});
