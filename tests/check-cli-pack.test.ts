import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { inspectPackEntries, readTarball } from "../scripts/check-cli-pack.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const checker = join(repoRoot, "scripts/check-cli-pack.mjs");

// Built by concatenation so this source file never contains a real-looking leak.
const HOME = "/" + "home/";
const CORE = "@zotoio/botz-mcp-swarm-" + "core";
const SERVICE = "@zotoio/botz-mcp-swarm";

type FileSpec = { path: string; content: string; mode?: number };

function tarHeader(name: string, size: number, mode: number): Buffer {
  const h = Buffer.alloc(512);
  let prefix = "";
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf("/", 155);
    prefix = name.slice(0, cut);
    base = name.slice(cut + 1);
  }
  h.write(base, 0, 100);
  h.write(mode.toString(8).padStart(7, "0") + "\0", 100);
  h.write("0000000\0", 108);
  h.write("0000000\0", 116);
  h.write(size.toString(8).padStart(11, "0") + "\0", 124);
  h.write("00000000000\0", 136);
  h.write("        ", 148);
  h.write("0", 156);
  h.write("ustar\0", 257);
  h.write("00", 263);
  h.write(prefix, 345, 155);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
}

function makeTgz(files: FileSpec[]): Buffer {
  const parts: Buffer[] = [];
  for (const f of files) {
    const body = Buffer.from(f.content);
    parts.push(tarHeader(`package/${f.path}`, body.length, f.mode ?? 0o644));
    parts.push(body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

function manifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: "@zotoio/botz-mcp-swarm-cli",
    version: "0.0.0",
    bin: { "botz-mcp-swarm": "./dist/cli.js", swarm: "./dist/cli.js" },
    files: ["dist"],
    dependencies: { commander: "^15.0.0", zod: "^3.25.0" },
    devDependencies: { typescript: "^5.8.2" },
    ...overrides,
  });
}

const CLEAN_CLI = [
  "#!/usr/bin/env node",
  'import { Command } from "commander";',
  'import { z } from "zod";',
  'import { readFileSync } from "node:fs";',
  'import path from "path";',
  'const msg = `could not load ${"x"} from "nowhere"`;',
  "",
].join("\n");

function cleanFiles(): FileSpec[] {
  return [
    { path: "package.json", content: manifest() },
    { path: "dist/cli.js", content: CLEAN_CLI, mode: 0o755 },
    { path: "LICENSE", content: "MIT License" },
  ];
}

function inspect(files: FileSpec[]) {
  return inspectPackEntries(readTarball(makeTgz(files))).findings.map((f) => f.rule);
}

describe("check-cli-pack", () => {
  it("passes a self-contained CLI tarball", () => {
    expect(inspect(cleanFiles())).toEqual([]);
  });

  it("reads long ustar paths split across prefix and name", () => {
    const long = `dist/${"nested/".repeat(16)}chunk.js`;
    const entries = readTarball(makeTgz([{ path: long, content: "x" }]));
    expect(entries.map((e) => e.path)).toEqual([`package/${long}`]);
  });

  it("fails on admin UI, sidecar, service, and .env paths", () => {
    const rules = inspect([
      ...cleanFiles(),
      { path: "dist/admin-ui/index.html", content: "" },
      { path: "sidecar/app.py", content: "" },
      { path: "packages/service/dist/index.js", content: "" },
      { path: "dist/service/server.js", content: "" },
      { path: ".env", content: "" },
    ]);
    expect(rules).toEqual(
      expect.arrayContaining(["admin-ui", "sidecar", "service-package", "service-server-module", "env-file", "unexpected-file"]),
    );
  });

  it("fails on absolute home paths and service markers inside the bundle", () => {
    const files = cleanFiles();
    files[1].content += `const root = "${HOME}alice/git/repo";\nexport function createSwarmServer() {}\n`;
    expect(inspect(files)).toEqual(expect.arrayContaining(["posix-home-path", "service-marker"]));
  });

  it("fails when the manifest depends on a private workspace package", () => {
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
      expect(inspect([{ path: "package.json", content: manifest({ [field]: { [CORE]: "0.5.3" } }) }, cleanFiles()[1]])).toContain(
        "private-dependency",
      );
    }
    expect(inspect([{ path: "package.json", content: manifest({ dependencies: { [SERVICE]: "^0.5.0", commander: "^15.0.0", zod: "^3" } }) }, cleanFiles()[1]])).toContain(
      "private-dependency",
    );
  });

  it("fails when packed devDependencies keep a private workspace package", () => {
    for (const name of [CORE, SERVICE]) {
      expect(inspect([{ path: "package.json", content: manifest({ devDependencies: { [name]: "0.5.3" } }) }, ...cleanFiles().slice(1)])).toEqual([
        "private-dev-dependency",
      ]);
    }
    expect(inspect([{ path: "package.json", content: manifest({ devDependencies: { [CORE]: "workspace:*" } }) }, cleanFiles()[1]])).toEqual(
      expect.arrayContaining(["private-dev-dependency", "workspace-range"]),
    );
  });

  it("fails on leftover workspace: ranges and a private manifest", () => {
    const rules = inspect([
      { path: "package.json", content: manifest({ private: true, devDependencies: { [CORE]: "workspace:*" } }) },
      cleanFiles()[1],
    ]);
    expect(rules).toEqual(expect.arrayContaining(["workspace-range", "private-manifest"]));
  });

  it("fails when the bin is missing, lacks a shebang, or is not executable", () => {
    expect(inspect([cleanFiles()[0]])).toEqual(expect.arrayContaining(["missing-cli", "missing-bin"]));
    const rules = inspect([cleanFiles()[0], { path: "dist/cli.js", content: CLEAN_CLI.replace(/^#!.*\n/, ""), mode: 0o644 }]);
    expect(rules).toEqual(expect.arrayContaining(["missing-shebang", "not-executable"]));
  });

  it("fails when the bundle imports core or an undeclared package", () => {
    const files = cleanFiles();
    files[1].content += `import { runManifest } from "${CORE}/core/runner.js";\nconst c = await import("cron");\n`;
    expect(inspect(files)).toEqual(expect.arrayContaining(["private-import", "undeclared-import"]));
  });

  it("exits 1 with findings for a planted tarball", () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-pack-guard-"));
    const tgz = join(dir, "bad.tgz");
    writeFileSync(tgz, makeTgz([...cleanFiles(), { path: "dist/admin-ui/app.js", content: "" }]));
    const result = spawnSync(process.execPath, [checker, "--tarball", tgz], { cwd: repoRoot, encoding: "utf8" });
    rmSync(dir, { recursive: true, force: true });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/\[admin-ui\]/);
  });

  it.skipIf(!existsSync(join(repoRoot, "dist/cli.js")))("passes on the real CLI pack", () => {
    const result = spawnSync(process.execPath, [checker, "--no-build"], { cwd: repoRoot, encoding: "utf8" });
    expect(result.stderr.replace(/^\[WARN\].*\n?/gm, "")).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/package\/dist\/cli\.js/);
  });
});
