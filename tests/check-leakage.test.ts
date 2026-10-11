import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const checker = join(repoRoot, "scripts/check-leakage.mjs");

// Built by concatenation so this source file never contains a real-looking leak.
const HOME = "/" + "home/";
const USERS = "/" + "Users/";
const WIN_USERS = "C:" + "\\Users\\";
const FAKE_TOKEN = "gh" + "p_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";

function runOn(content: string, name = "planted.md") {
  const dir = mkdtempSync(join(tmpdir(), "leakage-guard-"));
  const file = join(dir, name);
  writeFileSync(file, content);
  const result = spawnSync(process.execPath, [checker, "--files", file], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  rmSync(dir, { recursive: true, force: true });
  return result;
}

describe("check-leakage", () => {
  it("passes on the current repo tree", () => {
    const result = spawnSync(process.execPath, [checker], { cwd: repoRoot, encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("OK");
  });

  it("scans package sources and the admin UI by default", async () => {
    const { isExcluded } = await import("../scripts/check-leakage.mjs");
    expect(isExcluded("packages/core/src/core/redaction.test.ts")).toBe(false);
    expect(isExcluded("packages/service/src/service/server.ts")).toBe(false);
    expect(isExcluded("packages/service/admin-ui/src/App.tsx")).toBe(false);
    expect(isExcluded("packages/service/admin-ui/node_modules/x/index.js")).toBe(true);
    expect(isExcluded("packages/service/admin-ui/dist/index.html")).toBe(true);
  });

  it("fails on a synthetic POSIX home path", () => {
    const result = runOn(`Run from ${HOME}alice/git/botz-mcp-swarm\n`);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/planted\.md:1: \[posix-home-path\]/);
  });

  it("fails on macOS and Windows user profile paths", () => {
    const result = runOn(`a: ${USERS}bob/project\nb: ${WIN_USERS}carol\\project\nc: ${HOME}...x/data\n`);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/planted\.md:1: \[macos-user-path\]/);
    expect(result.stderr).toMatch(/planted\.md:2: \[windows-user-path\]/);
    expect(result.stderr).toMatch(/planted\.md:3: \[posix-home-path\]/);
  });

  it("checks every Windows profile path on a line, after an elided one", () => {
    const result = runOn(
      [
        `see C:${USERS}... then ${"D:" + "\\Users\\"}dave\\project`,
        `see ${WIN_USERS}...\\x then ${"E:" + USERS}erin/project`,
        `elided C:${USERS}... and ${WIN_USERS}...\\x only`,
        "",
      ].join("\n"),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/planted\.md:1: \[windows-user-path\]/);
    expect(result.stderr).toMatch(/planted\.md:2: \[windows-user-path\]/);
    expect(result.stderr).not.toMatch(/planted\.md:2: \[macos-user-path\]/);
    expect(result.stderr).not.toMatch(/planted\.md:3:/);
  });

  it("fails on colon-joined home and user paths", () => {
    const result = runOn(
      [
        `PATH=/usr/bin:${HOME}alice/bin`,
        `scp build.tgz deploy:${USERS}bob/drop`,
        `rsync -a ./out host:${HOME}carol/x`,
        "",
      ].join("\n"),
      "planted.sh",
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/planted\.sh:1: \[posix-home-path\]/);
    expect(result.stderr).toMatch(/planted\.sh:2: \[macos-user-path\]/);
    expect(result.stderr).toMatch(/planted\.sh:3: \[posix-home-path\]/);
  });

  it("fails on file:// home and user URLs but not network URL paths", () => {
    const result = runOn(
      [
        `open file://${HOME}alice/report.html`,
        `open file://${USERS}bob/report.html`,
        `see https://docs.example.com${HOME}guide and http://127.0.0.1:3000${USERS}list`,
        "",
      ].join("\n"),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/planted\.md:1: \[posix-home-path\]/);
    expect(result.stderr).toMatch(/planted\.md:2: \[macos-user-path\]/);
    expect(result.stderr).not.toMatch(/planted\.md:3:/);
  });

  it("fails closed when git cannot list files", () => {
    const dir = mkdtempSync(join(tmpdir(), "leakage-guard-nogit-"));
    const result = spawnSync(process.execPath, [checker], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, GIT_CEILING_DIRECTORIES: tmpdir(), GIT_DIR: join(dir, "missing.git") },
    });
    rmSync(dir, { recursive: true, force: true });
    expect(result.status).toBe(2);
    expect(result.stdout).not.toContain("OK");
    expect(result.stderr).toMatch(/check-leakage: ERROR/);
  });

  it("passes on placeholders, loopback hosts, and empty env keys", () => {
    const result = runOn(
      [
        "cd <repo> && kill <sut-pid>",
        `mount ${HOME}<user>/data`,
        "OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318",
        "GITHUB_CLIENT_SECRET=",
        "export GITHUB_CLIENT_SECRET=your_oauth_app_client_secret",
        "SWARM_LLM_API_KEY=${SWARM_LLM_API_KEY}",
        "see https://example.com/home/docs",
        `profiles such as ${HOME}... and C:${USERS}... are elided`,
        "",
      ].join("\n"),
      "planted.env",
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("fails on committed secrets without printing the value", () => {
    const result = runOn(
      `GITHUB_CLIENT_SECRET=${FAKE_TOKEN}\n{"api_key": "${FAKE_TOKEN}"}\n`,
      "planted.env",
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/planted\.env:1: \[env-secret-assignment\]/);
    expect(result.stderr).toMatch(/planted\.env:2: \[literal-secret-assignment\]/);
    expect(result.stderr).toMatch(/\[provider-token\]/);
    expect(result.stderr).not.toContain(FAKE_TOKEN);
  });
});
