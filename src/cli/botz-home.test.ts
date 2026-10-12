import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  defaultSuiteDir,
  displayPath,
  ensureBotzHome,
  expandHome,
  findGitRoot,
  isPathLike,
  portablePath,
  resolveBotzHome,
  resolveSuiteArg,
  saveSuiteCredentials,
  suiteCredentials,
  suiteDirName,
} from "./botz-home.js";

let root = "";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "botz-home-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("botz home", () => {
  it("uses the git root that contains the cwd, even from a subdirectory", async () => {
    const repo = join(root, "repo");
    const sub = join(repo, "a", "b");
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(sub, { recursive: true });
    const botz = resolveBotzHome({ cwd: sub, home: join(root, "home") });
    expect(findGitRoot(sub)).toBe(repo);
    expect(botz).toMatchObject({
      dir: join(repo, ".botz", "mcp-swarm"),
      display: ".botz/mcp-swarm",
      suitesDir: join(repo, ".botz", "mcp-swarm", "suites"),
      runsDir: join(repo, ".botz", "mcp-swarm", "runs"),
      repoRoot: repo,
    });
    expect(defaultSuiteDir(botz, "my suite")).toBe(join(repo, ".botz", "mcp-swarm", "suites", "my-suite"));
    expect(displayPath(join(repo, ".botz", "mcp-swarm", "suites", "x"), botz, "fallback")).toBe(".botz/mcp-swarm/suites/x");
  });

  it("falls back to ~/.botz/mcp-swarm outside a git repo", async () => {
    const home = join(root, "home");
    const cwd = join(root, "plain");
    await mkdir(cwd, { recursive: true });
    const botz = resolveBotzHome({ cwd, home });
    expect(botz).toMatchObject({ dir: join(home, ".botz", "mcp-swarm"), display: "~/.botz/mcp-swarm", repoRoot: null });
    expect(botz.runsDir).toBe(join(home, ".botz", "mcp-swarm", "runs"));
    expect(displayPath(join(home, ".botz", "mcp-swarm", "suites", "x"), botz, "fallback")).toBe("~/.botz/mcp-swarm/suites/x");
    expect(displayPath(join(cwd, "out"), botz, "fallback")).toBe("out");
    expect(displayPath(join(root, "elsewhere"), botz, "fallback")).toBe("fallback");
  });

  it("writes a .gitignore for config.json and runs/ only inside a repo, and keeps an existing one", async () => {
    const repo = join(root, "ignore-repo");
    await mkdir(join(repo, ".git"), { recursive: true });
    const botz = resolveBotzHome({ cwd: repo, home: join(root, "home") });
    await ensureBotzHome(botz);
    const ignore = join(repo, ".botz", "mcp-swarm", ".gitignore");
    expect(await readFile(ignore, "utf8")).toBe("config.json\nconfig.json.*\nruns/\n");
    await writeFile(ignore, "*.tmp");
    await ensureBotzHome(botz);
    const lines = (await readFile(ignore, "utf8")).split("\n");
    expect(lines).toContain("*.tmp");
    expect(lines).toContain("config.json");
    expect(lines).toContain("runs/");
    expect(lines.some((line) => line.startsWith("suites"))).toBe(false);

    const home = join(root, "home-only");
    const outside = resolveBotzHome({ cwd: join(root, "plain"), home });
    await ensureBotzHome(outside);
    await expect(stat(join(home, ".botz", "mcp-swarm", ".gitignore"))).rejects.toThrow();
  });

  it("stores literal credentials per suite in config.json with owner-only access", async () => {
    const home = join(root, "cred-home");
    const botz = resolveBotzHome({ cwd: join(root, "plain"), home });
    await saveSuiteCredentials(botz, "one", { SWARM_TARGET_HEADER_X: "a" });
    await saveSuiteCredentials(botz, "two", { SWARM_TARGET_HEADER_X: "b" });
    expect(await suiteCredentials(botz, "one")).toEqual({ SWARM_TARGET_HEADER_X: "a" });
    expect(await suiteCredentials(botz, "two")).toEqual({ SWARM_TARGET_HEADER_X: "b" });
    expect(await suiteCredentials(botz, "three")).toEqual({});
    if (process.platform !== "win32") {
      expect((await stat(join(home, ".botz", "mcp-swarm", "config.json"))).mode & 0o777).toBe(0o600);
    }
  });

  it("resolves --suite as a path first, then as a name under the suites directory", async () => {
    const home = join(root, "suite-home");
    const cwd = join(root, "suite-cwd");
    await mkdir(join(home, ".botz", "mcp-swarm", "suites", "demo"), { recursive: true });
    await writeFile(join(home, ".botz", "mcp-swarm", "suites", "demo", "suite.json"), "{}");
    await mkdir(join(cwd, "local"), { recursive: true });
    await writeFile(join(cwd, "local", "suite.json"), "{}");
    const botz = resolveBotzHome({ cwd, home });
    expect(resolveSuiteArg("demo", botz)).toBe(join(home, ".botz", "mcp-swarm", "suites", "demo"));
    expect(resolveSuiteArg("local", botz)).toBe(join(cwd, "local"));
    expect(resolveSuiteArg("./missing", botz)).toBe(join(cwd, "missing"));
  });

  it("reads suitesDir and runsDir from settings.json relative to the git root, ~/, or absolute", async () => {
    const repo = join(root, "settings-repo");
    const home = join(root, "settings-home");
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(join(repo, ".botz", "mcp-swarm"), { recursive: true });
    const settings = join(repo, ".botz", "mcp-swarm", "settings.json");
    await writeFile(settings, JSON.stringify({ suitesDir: "qa/suites", runsDir: "~/swarm-runs" }));
    const botz = resolveBotzHome({ cwd: join(repo), home });
    expect(botz.suitesDir).toBe(join(repo, "qa", "suites"));
    expect(botz.runsDir).toBe(join(home, "swarm-runs"));
    expect(defaultSuiteDir(botz, "demo")).toBe(join(repo, "qa", "suites", "demo"));
    await writeFile(settings, JSON.stringify({ runsDir: join(root, "abs-runs") }));
    expect(resolveBotzHome({ cwd: repo, home }).runsDir).toBe(join(root, "abs-runs"));
    await writeFile(settings, JSON.stringify({ runsDir: "" }));
    expect(() => resolveBotzHome({ cwd: repo, home })).toThrow(/runsDir must be a non-empty path/);
    await writeFile(settings, "[");
    expect(() => resolveBotzHome({ cwd: repo, home })).toThrow(/expected JSON/);
  });

  it("gives the repo .botz precedence over ~/.botz for settings, suites, and credentials", async () => {
    const repo = join(root, "layer-repo");
    const home = join(root, "layer-home");
    const repoDir = join(repo, ".botz", "mcp-swarm");
    const userDir = join(home, ".botz", "mcp-swarm");
    await mkdir(join(repo, ".git"), { recursive: true });
    for (const dir of [join(repoDir, "suites", "shared"), join(userDir, "suites", "shared"), join(userDir, "suites", "home-only")]) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "suite.json"), "{}");
    }
    await writeFile(join(userDir, "settings.json"), JSON.stringify({ runsDir: "home-runs" }));
    await writeFile(join(userDir, "config.json"), JSON.stringify({ suites: { shared: { credentials: { A: "home", B: "home" } }, other: { credentials: { C: "home" } } } }));
    await writeFile(join(repoDir, "config.json"), JSON.stringify({ suites: { shared: { credentials: { A: "repo" } } } }));
    let botz = resolveBotzHome({ cwd: repo, home });
    expect(botz.runsDir).toBe(join(home, "home-runs"));
    expect(botz.suitesDir).toBe(join(repoDir, "suites"));
    expect(resolveSuiteArg("shared", botz)).toBe(join(repoDir, "suites", "shared"));
    expect(resolveSuiteArg("home-only", botz)).toBe(join(userDir, "suites", "home-only"));
    expect(await suiteCredentials(botz, "shared")).toEqual({ A: "repo", B: "home" });
    expect(await suiteCredentials(botz, "other")).toEqual({ C: "home" });
    await saveSuiteCredentials(botz, "shared", { D: "new" });
    expect(JSON.parse(await readFile(join(repoDir, "config.json"), "utf8")).suites).toEqual({ shared: { credentials: { A: "repo", D: "new" } } });
    await writeFile(join(repoDir, "settings.json"), JSON.stringify({ runsDir: "repo-runs" }));
    botz = resolveBotzHome({ cwd: repo, home });
    expect(botz.runsDir).toBe(join(repo, "repo-runs"));
  });

  it("still finds suites and credentials in the legacy .botz layout", async () => {
    const home = join(root, "legacy-home");
    const cwd = join(root, "legacy-cwd");
    await mkdir(join(home, ".botz", "suites", "old"), { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(join(home, ".botz", "suites", "old", "suite.json"), "{}");
    await writeFile(join(home, ".botz", "config.json"), JSON.stringify({ suites: { old: { credentials: { K: "v" } } } }));
    const botz = resolveBotzHome({ cwd, home });
    expect(resolveSuiteArg("old", botz)).toBe(join(home, ".botz", "suites", "old"));
    expect(await suiteCredentials(botz, "old")).toEqual({ K: "v" });
    await saveSuiteCredentials(botz, "new", { K: "w" });
    const moved = JSON.parse(await readFile(join(home, ".botz", "mcp-swarm", "config.json"), "utf8"));
    expect(moved.suites).toEqual({ old: { credentials: { K: "v" } }, new: { credentials: { K: "w" } } });
  });

  it("stores paths relative to the git root, else under home as ~/, else cwd-relative", () => {
    const gitRoot = join(root, "u", "proj");
    const home = join(root, "u");
    const cwd = join(root, "work");
    const inRepo = { gitRoot, home, cwd: join(gitRoot, "sub") };
    expect(portablePath(join(gitRoot, "sub", "srv.sh"), inRepo)).toBe("sub/srv.sh");
    expect(portablePath(join(home, "tools", "srv"), inRepo)).toBe("~/tools/srv");
    expect(portablePath("/usr/bin/node", inRepo)).toBe("/usr/bin/node");
    const outside = { gitRoot: null, home, cwd };
    expect(portablePath(join(gitRoot, "srv.sh"), outside)).toBe("~/proj/srv.sh");
    expect(portablePath(join(cwd, "srv.sh"), outside)).toBe("srv.sh");
    expect(expandHome("~/tools/srv", home)).toBe(join(home, "tools", "srv"));
    expect(expandHome("srv", home)).toBe("srv");
    expect(suiteDirName("../evil")).toBe("evil");
    expect(suiteDirName("127.0.0.1")).toBe("127.0.0.1");
  });

  it("treats separators, ~/, absolute values, and existing bare files as paths; flags and PATH names are not", async () => {
    const dir = join(root, "pathlike");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "srv.sh"), "");
    expect(isPathLike("srv.sh", dir, true)).toBe(true);
    expect(isPathLike("srv.sh", dir, false)).toBe(false);
    expect(isPathLike("node", dir, true)).toBe(false);
    expect(isPathLike("--port", dir, true)).toBe(false);
    expect(isPathLike("~/x", dir, false)).toBe(true);
    expect(isPathLike("bin/missing.js", dir, true)).toBe(true);
    expect(isPathLike("bin/missing.js", dir, false)).toBe(false);
  });
});

it("preserves independent credentials during concurrent config updates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "botz-concurrent-"));
  try {
    const home = join(dir, ".botz", "mcp-swarm");
    const botz = { dir: home, display: "~/.botz/mcp-swarm", suitesDir: join(home, "suites"), runsDir: join(home, "runs"), user: null, repoRoot: null, cwd: dir, home: dir };
    await Promise.all(Array.from({ length: 8 }, (_, i) => saveSuiteCredentials(botz, String(i), { KEY: `value-${i}` })));
    for (let i = 0; i < 8; i++) expect(await suiteCredentials(botz, String(i))).toEqual({ KEY: `value-${i}` });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
