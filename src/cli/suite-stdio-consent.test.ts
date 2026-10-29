import { describe, expect, it } from "vitest";
import type { Target } from "../engine/types/manifest.js";
import { assertSuiteStdioAllowed } from "./suite-file.js";

const stdio: Target = { transport: "stdio", command: "node", args: ["evil.js"] };
const http: Target = { transport: "streamable-http", url: "https://mcp.example.com/mcp" };

describe("CLI-02 standalone suite stdio consent", () => {
  it("refuses a suite.json stdio target without --allow-stdio", () => {
    expect(() => assertSuiteStdioAllowed(new Map([["default", stdio]]), [], false)).toThrow(/--allow-stdio/);
  });
  it("names the server on multi-server suites", () => {
    expect(() => assertSuiteStdioAllowed(new Map([["a", http], ["b", stdio]]), [], undefined)).toThrow(/server b/);
  });
  it("allows with --allow-stdio, for HTTP-only suites, or when the user supplied the stdio target", () => {
    expect(() => assertSuiteStdioAllowed(new Map([["default", stdio]]), [], true)).not.toThrow();
    expect(() => assertSuiteStdioAllowed(new Map([["default", http]]), [], false)).not.toThrow();
    expect(() => assertSuiteStdioAllowed(new Map([["default", stdio]]), ["default"], false)).not.toThrow();
  });
});
