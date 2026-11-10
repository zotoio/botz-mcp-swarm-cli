import { afterEach, describe, expect, it } from "vitest";
import { envTeamLevels, normalizePolicy } from "./policy.js";

const KEYS = [
  "GITHUB_ADMIN_TEAM_SLUGS",
  "GITHUB_EDITOR_TEAM_SLUGS",
  "GITHUB_RUNNER_TEAM_SLUGS",
  "GITHUB_VIEWER_TEAM_SLUGS",
  "GITHUB_TEAM_SLUGS",
  "GITHUB_ALLOWED_ORG",
];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("env GitHub team access levels", () => {
  it("is a no-op when unset (existing deploys unchanged)", () => {
    for (const k of KEYS) delete process.env[k];
    const p = normalizePolicy({ githubOrg: "zotoio", teamSlugs: [], adminTeamSlugs: ["ops"], roleBindings: [] });
    expect(p.teamSlugs).toEqual([]);
    expect(p.adminTeamSlugs).toEqual(["ops"]);
    expect(p.roleBindings).toEqual([]);
  });

  it("maps admin/editor/runner teams and strips org/ prefixes", () => {
    process.env.GITHUB_ADMIN_TEAM_SLUGS = "zotoio/botz-admins";
    process.env.GITHUB_EDITOR_TEAM_SLUGS = "botz-editors";
    process.env.GITHUB_RUNNER_TEAM_SLUGS = "botz-operators";
    const p = normalizePolicy({ githubOrg: "zotoio", adminTeamSlugs: ["ops"] });
    expect(p.adminTeamSlugs).toEqual(["ops", "botz-admins"]);
    expect(p.roleBindings).toEqual([
      { role: "editor", teamSlugs: ["botz-editors"], projectIds: [] },
      { role: "runner", teamSlugs: ["botz-operators"], projectIds: [] },
    ]);
    // no viewer teams: sign-in stays "any org member"
    expect(p.teamSlugs).toEqual([]);
  });

  it("viewer teams restrict sign-in to the union of level teams", () => {
    process.env.GITHUB_ADMIN_TEAM_SLUGS = "botz-admins";
    process.env.GITHUB_RUNNER_TEAM_SLUGS = "botz-operators";
    process.env.GITHUB_VIEWER_TEAM_SLUGS = "botz-viewers";
    const p = normalizePolicy({ githubOrg: "zotoio", teamSlugs: [] });
    expect(p.teamSlugs.sort()).toEqual(["botz-admins", "botz-operators", "botz-viewers"]);
  });

  it("does not duplicate bindings already persisted in policy.json", () => {
    process.env.GITHUB_RUNNER_TEAM_SLUGS = "botz-operators";
    const first = normalizePolicy({ githubOrg: "zotoio" });
    const again = normalizePolicy(first);
    expect(again.roleBindings).toHaveLength(1);
  });

  it("parses levels", () => {
    expect(envTeamLevels({ GITHUB_VIEWER_TEAM_SLUGS: "a, org/b" })).toEqual({
      admin: [],
      editor: [],
      runner: [],
      viewer: ["a", "b"],
    });
  });
});
