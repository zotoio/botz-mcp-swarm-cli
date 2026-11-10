import { afterEach, describe, expect, it } from "vitest";
import { inferenceUrl, resolveInferenceModel, resolveInferenceConfig, INFERENCE_PROVIDERS } from "@zotoio/botz-mcp-swarm-engine/core/inference-model.js";

describe("inference model", () => {
  it("routes each hosted provider's own key without using another platform's key", () => {
    for (const [provider, preset] of Object.entries(INFERENCE_PROVIDERS)) {
      if (["custom", "ollama"].includes(provider)) continue;
      const config = resolveInferenceConfig({ SWARM_LLM_PROVIDER: provider, SWARM_LLM_MODEL: "test-model",
        [preset.keys[0]!]: "test-provider-key", OPENAI_API_KEY: provider === "openai" ? "test-provider-key" : "test-other-key" });
      expect(config.apiKey).toBe("test-provider-key");
      expect(config.baseUrl).toBe(preset.baseUrl);
    }
    expect(resolveInferenceConfig({ SWARM_LLM_PROVIDER: "ollama", SWARM_LLM_MODEL: "installed-model" }).apiKey).toBe("ollama");
    expect(resolveInferenceConfig({ CURSOR_API_KEY: "test-key" }).provider).toBe("cursor");
    expect(() => resolveInferenceConfig({ OPENAI_API_KEY: "test-key", CURSOR_API_KEY: "test-key" })).toThrow(/Multiple/);
    expect(() => resolveInferenceConfig({ SWARM_LLM_PROVIDER: "groq" })).toThrow(/SWARM_LLM_MODEL/);
    expect(() => resolveInferenceConfig({ SWARM_LLM_PROVIDER: "custom", SWARM_LLM_MODEL: "local" })).toThrow(/BASE_URL/);
  });
  it("routes compatible inference endpoints without losing their API prefix", () => {
    expect(inferenceUrl("")).toBe("https://api.openai.com/v1/chat/completions");
    expect(inferenceUrl("http://127.0.0.1:11434/v1/")).toBe("http://127.0.0.1:11434/v1/chat/completions");
    for (const base of ["file:///tmp/model", "https://user:pass@example.com/v1", "https://example.com/v1?key=secret"]) {
      expect(() => inferenceUrl(base)).toThrow(/SWARM_LLM_BASE_URL/);
    }
  });
  const previous = process.env.SWARM_LLM_MODEL;

  afterEach(() => {
    if (previous === undefined) delete process.env.SWARM_LLM_MODEL;
    else process.env.SWARM_LLM_MODEL = previous;
  });

  it("uses the fast model when nothing is configured", () => {
    delete process.env.SWARM_LLM_MODEL;
    expect(resolveInferenceModel(process.env.SWARM_LLM_MODEL)).toBe("gpt-5.4-nano");
    process.env.SWARM_LLM_MODEL = "  ";
    expect(resolveInferenceModel(process.env.SWARM_LLM_MODEL)).toBe("gpt-5.4-nano");
  });

  it("keeps an explicit override", () => {
    process.env.SWARM_LLM_MODEL = "gpt-4o-mini";
    expect(resolveInferenceModel(process.env.SWARM_LLM_MODEL)).toBe("gpt-4o-mini");
  });
});
