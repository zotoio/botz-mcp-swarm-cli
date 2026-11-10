import { describe, it, expect } from "vitest";
import { resolve, join } from "node:path";
import {
  resolveStdioTarget,
  buildStdioEnv,
  StdioPathError,
} from "@zotoio/botz-mcp-swarm-engine/core/target-resolve.js";
import { findRepoRoot } from "@zotoio/botz-mcp-swarm-engine/core/repo-root.js";

describe("target resolve", () => {
  it("resolves run.sh to absolute path with repo cwd", () => {
    const root = findRepoRoot();
    const target = resolveStdioTarget({
      transport: "stdio",
      command: "mock-server/run.sh",
    });
    expect(target.command).toBe(resolve(root, "mock-server/run.sh"));
    expect(target.cwd).toBe(root);
  });

  it("rejects parent-directory segments in command", () => {
    expect(() =>
      resolveStdioTarget({
        transport: "stdio",
        command: "../../etc/passwd",
      }),
    ).toThrow(StdioPathError);
  });

  it("strips NPM_CONFIG_PREFIX from stdio env", () => {
    const env = buildStdioEnv({ NPM_CONFIG_PREFIX: "/tmp/bad", FOO: "bar" });
    expect(env.NPM_CONFIG_PREFIX).toBeUndefined();
    expect(env.FOO).toBe("bar");
  });
});
