import { describe, it, expect } from "vitest";
import { redactHeaders, redactValue, redactString, REDACTED } from "@zotoio/botz-mcp-swarm-engine/core/redaction.js";

// Built by concatenation so the leakage check never sees a literal key in this file.
const FAKE_SK_DIGITS = "sk" + "-" + "12345678901234567890";
const FAKE_SK_ALPHA = "sk" + "-" + "abcdefghijklmnopqrst";
const FAKE_SK_PROJ = "sk" + "-proj-" + "Ab1_Cd2-Ef3Gh4Ij5Kl6Mn7Op8Qr9";
const FAKE_GHP = "gh" + "p_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const FAKE_PAT = "github" + "_pat_" + "11AAAAAAA0abcdefghijkl_mnopqrstuvwxyz0123456789";
const PLAIN = "plain" + "-literal-" + "value-1234";

describe("redaction", () => {
  it("redacts Authorization bearer tokens in strings", () => {
    const input = "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def";
    const result = redactString(input);
    expect(result).toContain(REDACTED);
    expect(result).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });

  it("redacts sensitive object keys", () => {
    const input = {
      authorization: "Bearer secret-token",
      message: "hello",
      nested: { api_key: FAKE_SK_DIGITS },
    };
    const result = redactValue(input) as Record<string, unknown>;
    expect(result.authorization).toBe(REDACTED);
    expect(result.message).toBe("hello");
    expect((result.nested as Record<string, unknown>).api_key).toBe(REDACTED);
  });

  it("redacts sk- prefixed API keys in strings", () => {
    const result = redactString(`key is ${FAKE_SK_ALPHA}`);
    expect(result).toContain(REDACTED);
    expect(result).not.toContain(FAKE_SK_ALPHA);
  });

  it("redacts project-scoped and GitHub provider tokens in strings", () => {
    const result = redactString(`a ${FAKE_SK_PROJ} b ${FAKE_GHP} c ${FAKE_PAT}`);
    expect(result).not.toContain(FAKE_SK_PROJ);
    expect(result).not.toContain(FAKE_GHP);
    expect(result).not.toContain(FAKE_PAT);
    expect(result).not.toContain("Ab1_Cd2");
  });

  it("redacts secret-shaped key names, not just exact ones", () => {
    const result = redactValue({
      GITHUB_TOKEN: PLAIN,
      client_secret: PLAIN,
      dbPassword: PLAIN,
      "X-Auth-Token": PLAIN,
      max_tokens: 100,
      query: "weather",
    }) as Record<string, unknown>;
    expect(JSON.stringify(result)).not.toContain(PLAIN);
    expect(result.max_tokens).toBe(100);
    expect(result.query).toBe("weather");
  });

  it("redacts secret-shaped header names", () => {
    const result = redactHeaders({ "Private-Token": PLAIN, "X-Api-Key": PLAIN, Accept: "application/json" });
    expect(result["Private-Token"]).toBe(REDACTED);
    expect(result["X-Api-Key"]).toBe(REDACTED);
    expect(result.Accept).toBe("application/json");
  });
});
