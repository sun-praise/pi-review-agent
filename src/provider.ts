import { createProvider, envApiKeyAuth, type Provider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

/**
 * Provider config for LiteLLM proxying DeepSeek.
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
  /** LiteLLM proxy base URL, e.g. "https://llm.sun-praise.com/v1". */
  baseURL: string;
  /** Env var name holding the API key. */
  envVar?: string;
  /** Provider id used as the Models-layer lookup key. */
  id?: string;
}

export function createLiteLLMDeepSeekProvider(
  opts: LiteLLMProviderOptions,
): Provider<"openai-completions"> {
  const id = opts.id ?? "litellm-deepseek";
  const envVar = opts.envVar ?? "LITELLM_API_KEY";

  return createProvider({
    id,
    name: `LiteLLM DeepSeek (${id})`,
    baseUrl: opts.baseURL,
    auth: { apiKey: envApiKeyAuth("LiteLLM API key", [envVar]) },
    models: [
      {
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        api: "openai-completions",
        provider: id,
        baseUrl: opts.baseURL,
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
        // DeepSeek public pricing (USD per 1M tokens).
        // cacheRead is the discounted rate for cache-hit input.
        cost: {
          input: 0.14,
          output: 0.28,
          cacheRead: 0.0028,
          cacheWrite: 0,
        },
        contextWindow: 1_000_000,
        maxTokens: 384_000,
      },
    ],
    api: openAICompletionsApi(),
  });
}
