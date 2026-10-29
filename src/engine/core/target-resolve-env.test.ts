import { describe, expect, it } from "vitest";
import { buildStdioEnv } from "./target-resolve.js";

const parent = {
  PATH: "/usr/bin", HOME: "<home>", LANG: "en_AU.UTF-8", TERM: "xterm", LC_ALL: "C",
  AWS_SECRET_ACCESS_KEY: "aws", GITHUB_TOKEN: "gh", OPENAI_API_KEY: "sk", NPM_CONFIG_PREFIX: "/x",
} as NodeJS.ProcessEnv;

describe("CLI-03 buildStdioEnv", () => {
  it("passes only allowlisted parent variables", () => {
    const env = buildStdioEnv(undefined, parent);
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "<home>", LANG: "en_AU.UTF-8", TERM: "xterm", LC_ALL: "C" });
  });
  it("adds explicitly configured env, which wins", () => {
    const env = buildStdioEnv({ API_KEY: "configured", PATH: "/opt/bin" }, parent);
    expect(env.API_KEY).toBe("configured");
    expect(env.PATH).toBe("/opt/bin");
    expect(env.GITHUB_TOKEN).toBeUndefined();
  });
  it("honours SWARM_STDIO_PASS_ENV opt-in names", () => {
    const env = buildStdioEnv(undefined, { ...parent, SWARM_STDIO_PASS_ENV: "GITHUB_TOKEN, NODE_ENV" });
    expect(env.GITHUB_TOKEN).toBe("gh");
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });
});
