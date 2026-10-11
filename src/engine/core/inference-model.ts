/** Fast default for tool-use probes, assertion judging, and description rewrites. */
export const DEFAULT_INFERENCE_MODEL = "gpt-5.4-nano";

/** MCP and model-call wait for a suite step that carries an LLM eval. */
export const LLM_STEP_TIMEOUT_MS = 300_000;

export const INFERENCE_PROVIDERS: Record<string, { baseUrl: string; keys: string[]; model?: string }> = {
  openai: { baseUrl: "https://api.openai.com/v1", keys: ["OPENAI_API_KEY"], model: DEFAULT_INFERENCE_MODEL },
  anthropic: { baseUrl: "https://api.anthropic.com/v1", keys: ["ANTHROPIC_API_KEY"] },
  gemini: { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", keys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"] },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", keys: ["OPENROUTER_API_KEY"] },
  groq: { baseUrl: "https://api.groq.com/openai/v1", keys: ["GROQ_API_KEY"] },
  deepseek: { baseUrl: "https://api.deepseek.com/v1", keys: ["DEEPSEEK_API_KEY"] },
  mistral: { baseUrl: "https://api.mistral.ai/v1", keys: ["MISTRAL_API_KEY"] },
  together: { baseUrl: "https://api.together.xyz/v1", keys: ["TOGETHER_API_KEY"] },
  xai: { baseUrl: "https://api.x.ai/v1", keys: ["XAI_API_KEY"] },
  ollama: { baseUrl: "http://127.0.0.1:11434/v1", keys: ["OLLAMA_API_KEY"] },
  cursor: { baseUrl: "cursor://completion", keys: ["CURSOR_API_KEY"], model: "auto" },
  custom: { baseUrl: "", keys: [] },
};

export function resolveInferenceConfig(env: NodeJS.ProcessEnv = process.env): { provider: string; baseUrl: string; apiKey: string; model: string } {
  let provider = env.SWARM_LLM_PROVIDER?.trim().toLowerCase();
  if (!provider) {
    if (env.SWARM_LLM_BASE_URL?.trim()) provider = "custom";
    else if (env.SWARM_LLM_API_KEY?.trim()) provider = "openai";
    else {
      const matches = Object.entries(INFERENCE_PROVIDERS).filter(([, value]) => value.keys.some((key) => env[key]?.trim()));
      if (matches.length > 1) throw new Error("Multiple inference provider keys are set; choose SWARM_LLM_PROVIDER explicitly");
      provider = matches[0]?.[0] ?? "openai";
    }
  }
  const preset = INFERENCE_PROVIDERS[provider];
  if (!preset) throw new Error(`Unknown SWARM_LLM_PROVIDER; choose ${Object.keys(INFERENCE_PROVIDERS).join(", ")}`);
  const baseUrl = env.SWARM_LLM_BASE_URL?.trim() || preset.baseUrl;
  if (!baseUrl) throw new Error("custom inference requires SWARM_LLM_BASE_URL");
  if (provider === "cursor" && env.SWARM_LLM_BASE_URL?.trim()) throw new Error("Cursor uses its SDK; unset SWARM_LLM_BASE_URL");
  const apiKey = env.SWARM_LLM_API_KEY?.trim() || preset.keys.map((key) => env[key]?.trim()).find(Boolean)
    || (provider === "custom" ? env.OPENAI_API_KEY?.trim() : "") || (provider === "ollama" ? "ollama" : "");
  const model = env.SWARM_LLM_MODEL?.trim() || preset.model || (provider === "custom" ? DEFAULT_INFERENCE_MODEL : "");
  if (!model) throw new Error(`Set SWARM_LLM_MODEL to an available ${provider} model`);
  return { provider, baseUrl, apiKey, model };
}

export function inferenceSecretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  return [env.SWARM_LLM_API_KEY ?? "", ...Object.values(INFERENCE_PROVIDERS).flatMap((provider) => provider.keys.map((key) => env[key] ?? ""))];
}

/** OpenAI-compatible API root, including /v1. Never falls back when an override is invalid. */
export function inferenceUrl(baseUrl = process.env.SWARM_LLM_BASE_URL): string {
  const base = new URL((baseUrl?.trim() || "https://api.openai.com/v1").replace(/\/+$/, "") + "/");
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error("SWARM_LLM_BASE_URL must be an HTTP(S) API root without credentials, query, or fragment");
  }
  return new URL("chat/completions", base).href;
}

/** Use the fast default when no model was set. A blank env value does not override it. */
export function resolveInferenceModel(explicit?: string): string {
  const chosen = explicit?.trim();
  return chosen || DEFAULT_INFERENCE_MODEL;
}

/** Token cap fields for the Chat Completions API. GPT-5 stays on the no-reasoning setting. */
export function inferenceLimits(model: string, maxTokens: number): Record<string, number | string> {
  if (model.startsWith("gpt-5")) {
    return { max_completion_tokens: maxTokens, reasoning_effort: "none" };
  }
  return { max_tokens: maxTokens };
}
