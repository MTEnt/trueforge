import type { CompletionUsage } from './LLMTypes';

export function estimateTokensForString(s: string): number {
  return s.length / 4;
}

export function mergeUsage(a: CompletionUsage, b: CompletionUsage): CompletionUsage {
  return {
    prompt_tokens: a.prompt_tokens + b.prompt_tokens,
    completion_tokens: a.completion_tokens + b.completion_tokens,
    total_tokens: a.total_tokens + b.total_tokens,
    costInUSD: (a.costInUSD ?? 0) + (b.costInUSD ?? 0),
    cache_read_input_tokens: (a.cache_read_input_tokens ?? 0) + (b.cache_read_input_tokens ?? 0),
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
