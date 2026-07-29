import type { CompletionUsage } from './LLMTypes';

export function estimateTokensForString(s: string): number {
  return s.length / 4;
}

/**
 * Anthropic `cache_read_input_tokens`, else OpenAI `prompt_tokens_details.cached_tokens`.
 *
 * Before (`a ?? b`):
 *   { cache_read_input_tokens: 0, prompt_tokens_details: { cached_tokens: 40 } } → 0
 *
 * After (`Math.max`):
 *   { cache_read_input_tokens: 0, prompt_tokens_details: { cached_tokens: 40 } } → 40
 *   { prompt_tokens_details: { cached_tokens: 40 } }                             → 40
 *   { cache_read_input_tokens: 40 }                                              → 40
 *   {}                                                                          → undefined
 */
export function resolveCacheReadTokens(usage: CompletionUsage): number | undefined {
  const cacheRead = usage.cache_read_input_tokens;
  const cached = usage.prompt_tokens_details?.cached_tokens;
  if (cacheRead === undefined && cached === undefined) {
    return undefined;
  }
  return Math.max(cacheRead ?? 0, cached ?? 0);
}

/** Folds both provider cache-read shapes into `cache_read_input_tokens` before summing. */
export function mergeUsage(a: CompletionUsage, b: CompletionUsage): CompletionUsage {
  return {
    prompt_tokens: a.prompt_tokens + b.prompt_tokens,
    completion_tokens: a.completion_tokens + b.completion_tokens,
    total_tokens: a.total_tokens + b.total_tokens,
    costInUSD: (a.costInUSD ?? 0) + (b.costInUSD ?? 0),
    cache_read_input_tokens: (resolveCacheReadTokens(a) ?? 0) + (resolveCacheReadTokens(b) ?? 0),
    cache_creation_input_tokens: (a.cache_creation_input_tokens ?? 0) + (b.cache_creation_input_tokens ?? 0),
    prompt_tokens_details: {
      cached_tokens: (a.prompt_tokens_details?.cached_tokens ?? 0) + (b.prompt_tokens_details?.cached_tokens ?? 0),
    },
    completion_tokens_details: {
      reasoning_tokens:
        (a.completion_tokens_details?.reasoning_tokens ?? 0) + (b.completion_tokens_details?.reasoning_tokens ?? 0),
    },
  };
}
