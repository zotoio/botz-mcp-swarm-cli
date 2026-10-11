import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function check(version: string, ref: string, prerelease?: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "release-guard-"));
  try {
    mkdirSync(join(dir, "scripts")); mkdirSync(join(dir, "packages/cli"), { recursive: true });
    writeFileSync(join(dir, "scripts/check-release.mjs"), readFileSync(resolve("scripts/check-release.mjs")));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version }));
    writeFileSync(join(dir, "event.json"), JSON.stringify({ release: { prerelease } }));
    const output = join(dir, "output");
    const result = spawnSync(process.execPath, [join(dir, "scripts/check-release.mjs")], { encoding: "utf8", env: {
      ...process.env, GITHUB_REF: ref, GITHUB_OUTPUT: output,
      GITHUB_EVENT_NAME: prerelease === undefined ? "workflow_dispatch" : "release", GITHUB_EVENT_PATH: join(dir, "event.json"),
    } });
    return { code: result.status, output: result.status === 0 ? readFileSync(output, "utf8") : "" };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
describe("release guard", () => {
  it("permits stable tags and chooses latest", () => expect(check("1.2.3", "refs/tags/v1.2.3", false)).toEqual({ code: 0, output: "tag=latest\n" }));
  it("permits prerelease tags and chooses next", () => expect(check("1.2.3-rc.1", "refs/tags/v1.2.3-rc.1", true)).toEqual({ code: 0, output: "tag=next\n" }));
  it("rejects branches and mismatched tags", () => {
    expect(check("1.2.3", "refs/heads/main").code).not.toBe(0);
    expect(check("1.2.3", "refs/tags/v1.2.4").code).not.toBe(0);
  });
  it("rejects mismatched prerelease metadata", () => expect(check("1.2.3-rc.1", "refs/tags/v1.2.3-rc.1", false).code).not.toBe(0));
});
