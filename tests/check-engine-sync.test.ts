import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { computeEngineTreeHash } from "../scripts/compute-engine-tree-hash.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const checker = join(repoRoot, "scripts/check-engine-sync.mjs");

describe("check-engine-sync", () => {
  it("passes when ENGINE_SOURCE.json matches the working tree hash", () => {
    const dir = mkdtempSync(join(tmpdir(), "engine-sync-"));
    const engineRoot = join(dir, "engine");
    mkdirSync(join(engineRoot, "core"), { recursive: true });
    writeFileSync(join(engineRoot, "core", "sample.ts"), "export const x = 1;\n");
    const hash = computeEngineTreeHash(engineRoot);
    writeFileSync(
      join(engineRoot, "ENGINE_SOURCE.json"),
      JSON.stringify({
        platformCommit: "abc1234567890abcdef1234567890abcdef12345678",
        treeSha256: hash,
        dependencyRanges: {},
      }),
    );
    const pkgDir = join(dir, "pkg");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "test", dependencies: {} }), "utf8");
    writeFileSync(
      join(dir, "check.mjs"),
      `import { readFileSync } from "node:fs";
       import { join } from "node:path";
       import { computeEngineTreeHash } from ${JSON.stringify(join(repoRoot, "scripts/compute-engine-tree-hash.mjs"))};
       const engineRoot = ${JSON.stringify(engineRoot)};
       const manifest = JSON.parse(readFileSync(join(engineRoot, "ENGINE_SOURCE.json"), "utf8"));
       if (manifest.treeSha256 !== computeEngineTreeHash(engineRoot)) process.exit(1);`,
    );
    const result = spawnSync(process.execPath, [join(dir, "check.mjs")], { cwd: repoRoot, encoding: "utf8" });
    rmSync(dir, { recursive: true, force: true });
    expect(result.status).toBe(0);
  });

  it("passes on the vendored engine tree in this repo", () => {
    const result = spawnSync(process.execPath, [checker], { cwd: repoRoot, encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OK engine tree");
    expect(result.stdout).toMatch(/sync [0-9a-f]{7}/);
  });
});
