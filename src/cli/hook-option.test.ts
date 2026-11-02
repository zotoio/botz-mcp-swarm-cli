import { describe, expect, it } from "vitest";
import { parseHookOption } from "./project-ops.js";

describe("--hook option", () => {
  it("accepts setup/teardown, clears with none, rejects others", () => {
    expect(parseHookOption("setup")).toBe("setup");
    expect(parseHookOption(" Teardown ")).toBe("teardown");
    expect(parseHookOption("none")).toBeUndefined();
    expect(() => parseHookOption("before")).toThrow(/unknown_hook/);
  });
});
