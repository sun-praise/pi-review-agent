import { createProvider, envApiKeyAuth, type Provider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { resolveModelIds } from "./model-ids.js";
import { DEFAULT_DEEPSEEK_COST, type ModelCostTable } from "./model-cost.js";

/**
 * Provider config for LiteLLM proxying a DeepSeek-shaped model.
 *
 * Why this exact shape:
 * - `provider` field on the model is REQUIRED. createProvider() does not inject
 *   it; Models-layer dispatch (streamSimple/getAuth) looks up providers by
 *   model.provider and fails silently ("Unknown provider: undefined") if absent.
 * - `cost.cacheRead` is the discounted rate for cache-hit input tokens.
 *   pi-ai's calculateCost() multiplies this by usage.cacheRead automatically,
 *   so cost tables reflect real savings (DeepSeek charges ~2% of input price
 *   for cached tokens). Without this, the agent would report full-price cost
 *   even when the upstream returned cached_tokens.
 * - `compat.thinkingFormat: "deepseek"` makes pi-ai parse deepseek's reasoning
 *   stream shape correctly (reasoning_content on assistant messages).
 * - baseUrl points at the LiteLLM proxy; the upstream (DeepSeek) does
 *   content-addressed prefix caching and returns prompt_tokens_details.cached_tokens
 *   in both streaming and non-streaming responses.
 */
export interface LiteLLMProviderOptions {
  /**
   * LiteLLM proxy base URL. Accepted with or without a trailing /v1 —
   * normalized internally since the OpenAI SDK appends /chat/completions.
   * Examples: "https://llm.sun-praise.com" or "https://llm.sun-praise.com/v1".
   */
  baseURL: string;
  /** Env var name holding the API key. */
  envVar?: string;
  /** Provider id used as the Models-layer lookup key. */
  id?: string;
  /**
   * Every model id to register under this provider, deduped in order. The
   * first entry is the primary reviewer model; later entries cover per-role
   * overrides (coordinator/verifier) and the fallback chain. Every id that
   * runReview/runModelAttempt may request MUST be listed here — pi-ai's
   * Models.getModel() is a strict find over this list and returns undefined
   * for unregistered ids. Default ["deepseek-v4-flash"].
   *
   * Cost/compat stay DeepSeek-shaped for all entries; only the ids change
   * (works for any deepseek-* model behind the same litellm proxy).
   */
  modelIds?: string[];
  /**
   * Real price tables for non-DeepSeek ids (USD per 1M tokens), keyed by
   * model id — without them every id is billed in summaries at DeepSeek-flash
   * rates (#47). Overrides replace the default table wholesale; ids without
   * an entry keep the DeepSeek estimate. See model-cost.ts for parsing.
   */
  costByModel?: Record<string, ModelCostTable>;
}

export function createLiteLLMDeepSeekProvider(
  opts: LiteLLMProviderOptions,
): Provider<"openai-completions"> {
  const id = opts.id ?? "litellm-deepseek";
  const envVar = opts.envVar ?? "LITELLM_API_KEY";
  const modelIds = resolveModelIds(opts.modelIds ?? []);
  // Accept baseURL with or without trailing /v1. The OpenAI SDK appends
  // /chat/completions, so litellm expects the /v1 prefix here. Normalize once.
  const baseURL = opts.baseURL.endsWith("/v1")
    ? opts.baseURL
    : `${opts.baseURL.replace(/\/+$/, "")}/v1`;

  return createProvider({
    id,
    name: `LiteLLM DeepSeek (${id})`,
    baseUrl: baseURL,
    auth: { apiKey: envApiKeyAuth("LiteLLM API key", [envVar]) },
    models: modelIds.map((mid) => ({
      id: mid,
      name: mid,
      api: "openai-completions",
      provider: id,
      baseUrl: baseURL,
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        requiresReasoningContentOnAssistantMessages: true,
        thinkingFormat: "deepseek",
      },
      reasoning: true,
      thinkingLevelMap: {
        minimal: null,
        low: null,
        medium: null,
        high: "high",
        xhigh: "max",
      },
      input: ["text"],
      // Cost: per-id override if provided, else the DeepSeek-flash estimate
      // (model-cost.ts is the single source for the default table).
      cost: opts.costByModel?.[mid] ?? DEFAULT_DEEPSEEK_COST,
      contextWindow: 1_000_000,
      maxTokens: 384_000,
    })),
    api: openAICompletionsApi(),
  });
}
