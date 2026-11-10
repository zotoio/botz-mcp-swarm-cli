import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadLocalEnv } from "@zotoio/botz-mcp-swarm-engine/load-local-env.js";
import { normalizePolicy } from "@zotoio/botz-mcp-swarm-engine/service/policy.js";

const KEYS = [
  "SWARM_ENV_LOCAL_TEST_KEY",
  "SWARM_ENV_LOCAL_ONLY",
  "SWARM_ENV_BASE_ONLY",
  "SWARM_ENV_BOTH",
  "GITHUB_ALLOWED_ORG",
  "GITHUB_TEAM_SLUGS",
] as const;

afterEach(() => {
  for (const key of KEYS) delete process.env[key];
});

describe("loadLocalEnv", () => {
  it("prefers the shell, then .env.local, then .env", async () => {
    const dir = await mkdtemp(join(tmpdir(), "swarm-env-"));
    process.env.SWARM_ENV_LOCAL_TEST_KEY = "from-shell";
    await writeFile(
      join(dir, ".env.local"),
      [
        "SWARM_ENV_LOCAL_TEST_KEY=from-file",
        "SWARM_ENV_LOCAL_ONLY=from-file",
        "SWARM_ENV_BOTH=from-file",
      ].join("\n"),
    );
    await writeFile(
      join(dir, ".env"),
      [
        "SWARM_ENV_LOCAL_TEST_KEY=from-base",
        "SWARM_ENV_BASE_ONLY=from-base",
        "SWARM_ENV_BOTH=from-base",
      ].join("\n"),
    );

    try {
      loadLocalEnv(dir);
      expect(process.env.SWARM_ENV_LOCAL_TEST_KEY).toBe("from-shell");
      expect(process.env.SWARM_ENV_LOCAL_ONLY).toBe("from-file");
      expect(process.env.SWARM_ENV_BOTH).toBe("from-file");
      expect(process.env.SWARM_ENV_BASE_ONLY).toBe("from-base");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("normalizePolicy env defaults", () => {
  it("uses GITHUB_ALLOWED_ORG when policy.json has no org", () => {
    process.env.GITHUB_ALLOWED_ORG = "acme";
    process.env.GITHUB_TEAM_SLUGS = "platform, ops";
    expect(normalizePolicy({}).githubOrg).toBe("acme");
    expect(normalizePolicy({}).teamSlugs).toEqual(["platform", "ops"]);
  });

  it("keeps an org already stored in policy.json", () => {
    process.env.GITHUB_ALLOWED_ORG = "acme";
    process.env.GITHUB_TEAM_SLUGS = "platform";
    const policy = normalizePolicy({ githubOrg: "zotoio", teamSlugs: [] });
    expect(policy.githubOrg).toBe("zotoio");
    expect(policy.teamSlugs).toEqual([]);
  });
});
