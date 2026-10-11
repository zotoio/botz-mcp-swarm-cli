import { describe, it, expect } from "vitest";
import type { Target } from "../engine/types/manifest.js";
import { assertNoUrlCredentials, formatAuth, moveUrlCredentials as migrateUrlCredentials, applyAuthFlags, resolveTargetSecrets, splitLiteralCredentials, storedSecretNames } from "./suite-auth.js";

const moveUrlCredentials = (target: Target) => migrateUrlCredentials(target, true);

// Built by concatenation so the leakage check never sees a literal token in this file.
const GH_TOKEN = "gh" + "p_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const SK_PROJ = "sk" + "-proj-" + "Ab1_Cd2-Ef3Gh4Ij5Kl6Mn7Op8Qr9";
const PLAIN = "plain" + "-literal-" + "value-1234";

describe("suite auth display", () => {
  it("never prints literal values of secret-named stdio env vars", () => {
    const target = {
      transport: "stdio",
      command: "node",
      args: ["server.js"],
      env: { GITHUB_TOKEN: GH_TOKEN, OPENAI_API_KEY: SK_PROJ, DB_PASSWORD: PLAIN, LOG_LEVEL: "debug" },
    } as Target;
    const lines = formatAuth(target).join("\n");
    expect(lines).not.toContain(GH_TOKEN);
    expect(lines).not.toContain(SK_PROJ);
    expect(lines).not.toContain(PLAIN);
    expect(lines).toContain("LOG_LEVEL: debug");
    expect(storedSecretNames(target).sort()).toEqual(["DB_PASSWORD", "GITHUB_TOKEN", "OPENAI_API_KEY"]);
  });

  it("never prints literal values of secret-named HTTP headers", () => {
    const target = {
      transport: "streamable-http",
      url: "https://mcp.example.com/mcp",
      headers: { "X-Auth-Token": PLAIN, "Private-Token": GH_TOKEN, Accept: "application/json" },
    } as Target;
    const lines = formatAuth(target).join("\n");
    expect(lines).not.toContain(PLAIN);
    expect(lines).not.toContain(GH_TOKEN);
    expect(lines).toContain("Accept: application/json");
    expect(storedSecretNames(target).sort()).toEqual(["Private-Token", "X-Auth-Token"]);
  });

  it("keeps env references visible", () => {
    const target = {
      transport: "stdio",
      command: "node",
      env: { GITHUB_TOKEN: "${env:GITHUB_TOKEN}" },
    } as Target;
    expect(formatAuth(target)).toEqual(["  GITHUB_TOKEN: ${env:GITHUB_TOKEN}"]);
    expect(storedSecretNames(target)).toEqual([]);
  });
});

describe("moveUrlCredentials", () => {
  const base = "http://127.0.0.1:9/mcp";

  it("turns an API key query parameter into a bearer header and strips it from the URL", () => {
    for (const param of ["api_key", "APIKEY", "api-key", "x-api-key", "Subscription-Key", "key", "token", "access_token"]) {
      const moved = moveUrlCredentials({ transport: "streamable-http", url: `${base}?${param}=${PLAIN}&mode=x` });
      expect(moved.movedParam).toBe(param);
      expect(moved.target).toEqual({
        transport: "streamable-http",
        url: `${base}?mode=x`,
        headers: { Authorization: `Bearer ${PLAIN}` },
      });
    }
    const split = splitLiteralCredentials(moveUrlCredentials({ transport: "streamable-http", url: `${base}?api_key=${PLAIN}` }).target);
    expect(split.target).toEqual({
      transport: "streamable-http",
      url: base,
      headers: { Authorization: "Bearer ${env:SWARM_TARGET_HEADER_AUTHORIZATION}" },
    });
    expect(split.credentials).toEqual({ SWARM_TARGET_HEADER_AUTHORIZATION: PLAIN });
  });

  it("leaves a URL without credentials alone", () => {
    const target = { transport: "streamable-http", url: `${base}?mode=x` } as Target;
    expect(moveUrlCredentials(target)).toEqual({ target });
  });

  it("refuses userinfo, a second key, and a key alongside an Authorization header", () => {
    const userinfo = "http://" + "u1:" + PLAIN + "@127.0.0.1:9/mcp";
    expect(() => moveUrlCredentials({ transport: "streamable-http", url: userinfo })).toThrow(/--bearer-env or --header/);
    expect(() => moveUrlCredentials({ transport: "streamable-http", url: `${base}?key=a&token=b` })).toThrow(/more than one/);
    expect(() => moveUrlCredentials({
      transport: "streamable-http",
      url: `${base}?api_key=${PLAIN}`,
      headers: { authorization: "Bearer ${env:MCP_TOKEN}" },
    })).toThrow(/Authorization header is also set/);
    let message = "";
    try {
      moveUrlCredentials({ transport: "streamable-http", url: userinfo });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain(PLAIN);
  });

  it("keeps the original encoding of the other query parameters and the fragment", () => {
    const moved = moveUrlCredentials({
      transport: "streamable-http",
      url: `${base}?q=a%20b&plus=c+d&api_key=${PLAIN}&tilde=%7Ex#frag`,
    });
    expect(moved.target.transport === "stdio" ? "" : moved.target.url).toBe(`${base}?q=a%20b&plus=c+d&tilde=%7Ex#frag`);
    const only = moveUrlCredentials({ transport: "streamable-http", url: `${base}?api_key=${PLAIN}` });
    expect(only.target.transport === "stdio" ? "" : only.target.url).toBe(base);
  });

  it("decodes the key value like a form value", () => {
    const moved = moveUrlCredentials({ transport: "streamable-http", url: `${base}?api_key=a%2Bb%3D` });
    expect(moved.target.transport === "stdio" ? {} : moved.target.headers).toEqual({ Authorization: "Bearer a+b=" });
  });
});

describe("assertNoUrlCredentials", () => {
  const base = "http://127.0.0.1:9/mcp";

  it("refuses credential query parameters that are not moved, without printing the value", () => {
    for (const param of ["private_key", "client_key", "auth", "pwd", "client_secret", "password"]) {
      let message = "";
      try {
        assertNoUrlCredentials({ transport: "streamable-http", url: `${base}?mode=x&${param}=${PLAIN}` });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain(`query parameter ${param}`);
      expect(message).toMatch(/--header or --bearer-env/);
      expect(message).not.toContain(PLAIN);
    }
  });

  it("refuses credentials in the fragment and never moves them", () => {
    const url = `${base}?mode=x#access_token=${PLAIN}&token_type=bearer`;
    expect(moveUrlCredentials({ transport: "streamable-http", url })).toEqual({
      target: { transport: "streamable-http", url },
    });
    let message = "";
    try {
      assertNoUrlCredentials({ transport: "streamable-http", url });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/fragment holds a credential \(access_token\)/);
    expect(message).not.toContain(PLAIN);
  });

  it("allows ordinary parameters, fragments, and stdio targets", () => {
    expect(() => assertNoUrlCredentials({ transport: "streamable-http", url: `${base}?mode=x&auth_mode=none#section-2` })).not.toThrow();
    expect(() => assertNoUrlCredentials({ transport: "stdio", command: "node" })).not.toThrow();
  });
});

describe("splitLiteralCredentials", () => {
  it("keeps the Bearer scheme in the suite and moves only the token", () => {
    const { target, credentials } = splitLiteralCredentials({
      transport: "streamable-http",
      url: "http://127.0.0.1/mcp",
      headers: { Authorization: `Bearer ${PLAIN}` },
    });
    expect(target).toMatchObject({ headers: { Authorization: "Bearer ${env:SWARM_TARGET_HEADER_AUTHORIZATION}" } });
    expect(credentials).toEqual({ SWARM_TARGET_HEADER_AUTHORIZATION: PLAIN });
  });

  it("moves every literal header to a SWARM_TARGET_HEADER_* reference and keeps exact references", () => {
    const { target, credentials } = splitLiteralCredentials({
      transport: "streamable-http",
      url: "http://127.0.0.1/mcp",
      headers: {
        "X-Api-Key": PLAIN,
        Accept: "application/json",
        Authorization: "Bearer ${env:MCP_TOKEN}",
        "X-Mixed": "pre ${env:MCP_TOKEN} post",
      },
    });
    expect(target).toMatchObject({
      headers: {
        "X-Api-Key": "${env:SWARM_TARGET_HEADER_X_API_KEY}",
        Accept: "${env:SWARM_TARGET_HEADER_ACCEPT}",
        Authorization: "Bearer ${env:MCP_TOKEN}",
        "X-Mixed": "${env:SWARM_TARGET_HEADER_X_MIXED}",
      },
    });
    expect(credentials).toEqual({
      SWARM_TARGET_HEADER_X_API_KEY: PLAIN,
      SWARM_TARGET_HEADER_ACCEPT: "application/json",
      SWARM_TARGET_HEADER_X_MIXED: "pre ${env:MCP_TOKEN} post",
    });
    expect(JSON.stringify(target)).not.toContain(PLAIN);
  });

  it("moves literal stdio env values and avoids clashing with a reference already in use", () => {
    const { target, credentials } = splitLiteralCredentials({
      transport: "stdio",
      command: "node",
      env: { GITHUB_TOKEN: GH_TOKEN, OTHER: "${env:SWARM_TARGET_ENV_GITHUB_TOKEN}" },
    });
    expect(target).toMatchObject({
      env: { GITHUB_TOKEN: "${env:SWARM_TARGET_ENV_GITHUB_TOKEN_2}", OTHER: "${env:SWARM_TARGET_ENV_GITHUB_TOKEN}" },
    });
    expect(credentials).toEqual({ SWARM_TARGET_ENV_GITHUB_TOKEN_2: GH_TOKEN });
  });
});


describe("explicit credentials", () => {
  it("refuses implicit query-to-bearer conversion", () => {
    expect(() => migrateUrlCredentials({ transport: "streamable-http", url: "https://example.com/mcp?api_key=fixture" })).toThrow(/--url-key-as-bearer/);
  });
  it("replaces Authorization regardless of casing, including before resolving stale env references", () => {
    for (const name of ["authorization", "AUTHORIZATION", "Authorization"]) {
      const target = resolveTargetSecrets(applyAuthFlags({ transport: "streamable-http", url: "https://example.com",
        headers: { [name]: "Bearer ${env:UNSET_OLD_KEY}" } }, { bearerEnv: "NEW_KEY" }), { NEW_KEY: "fixture" });
      expect(target.transport === "stdio" ? null : [...new Headers(target.headers)]).toEqual([["authorization", "Bearer fixture"]]);
    }
  });
});
