import { describe, expect, it } from "vitest";
import { scriptElicitResult } from "./elicit-reply.js";

const form = {
  requestedSchema: {
    properties: {
      confirm: { type: "boolean", default: true },
      role: {
        type: "string",
        oneOf: [
          { const: "reader" },
          { const: "writer" },
        ],
      },
      tags: {
        type: "array",
        minItems: 2,
        items: { enum: ["a", "b"] },
      },
      email: { type: "string", format: "email" },
      count: { type: "integer", minimum: 3 },
      note: { type: "string" },
    },
    required: ["confirm", "role", "tags", "email", "count"],
  },
};

describe("elicitation script", () => {
  it("keeps valid scripted fields and fills the rest from the schema", () => {
    const result = scriptElicitResult(form, {
      action: "accept",
      content: { confirm: true, role: "writer", email: "not-an-email", note: "kept" },
    });
    expect(result).toEqual({
      action: "accept",
      content: {
        confirm: true,
        role: "writer",
        tags: ["a", "a"],
        email: "swarm@example.com",
        count: 3,
        note: "kept",
      },
    });
  });

  it("uses the first oneOf const when the script does not choose one", () => {
    const result = scriptElicitResult(form, { action: "accept", content: {} });
    expect(result.content?.role).toBe("reader");
    expect(result.content?.confirm).toBe(true);
  });

  it("sends no content for decline, cancel, or URL mode", () => {
    expect(scriptElicitResult(form, { action: "decline", content: { confirm: true } })).toEqual({
      action: "decline",
    });
    expect(scriptElicitResult(form, { action: "cancel" })).toEqual({ action: "cancel" });
    expect(
      scriptElicitResult({ mode: "url" }, { action: "accept", content: { confirm: true } }),
    ).toEqual({ action: "accept" });
  });

  it("defaults approve/confirm booleans to true and details string to a rich brief on accept", () => {
    const res = scriptElicitResult(
      {
        requestedSchema: {
          properties: {
            approve: { type: "boolean" },
            details: { type: "string" },
            changes: { type: "string", default: "" },
          },
          required: ["approve", "details"],
        },
      },
      { action: "accept" },
    );
    expect(res.action).toBe("accept");
    expect(res.content?.approve).toBe(true);
    expect(String(res.content?.details).length).toBeGreaterThan(20);
    expect(res.content?.changes).toBe("");
  });
});
