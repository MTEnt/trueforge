import { CompletionUsageSchema, getEmptyUsage } from '../../src/core/llm/LLMTypes';
import { mergeUsage, resolveCacheReadTokens } from '../../src/core/llm/usage';

describe('completion usage cost', () => {
  it('accepts gateway-computed cost', () => {
    expect(
      CompletionUsageSchema.parse({
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        costInUSD: 0.12,
      }).costInUSD,
    ).toBe(0.12);
  });

  it('sums cost across model calls', () => {
    const merged = mergeUsage(
      {
        ...getEmptyUsage(),
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
        costInUSD: 0.12,
      },
      {
        ...getEmptyUsage(),
        prompt_tokens: 20,
        completion_tokens: 8,
        total_tokens: 28,
        costInUSD: 0.23,
      },
    );

    expect(merged).toMatchObject({
      prompt_tokens: 30,
      completion_tokens: 13,
      total_tokens: 43,
    });
    expect(merged.costInUSD).toBe(0.12 + 0.23);
  });

  it('retains full precision and never rounds cost to cents', () => {
    // Sub-cent inputs must survive verbatim; any rounding to 2 dp would collapse these to 0.
    const merged = mergeUsage({ ...getEmptyUsage(), costInUSD: 0.0001 }, { ...getEmptyUsage(), costInUSD: 0.0002 });

    expect(merged.costInUSD).toBe(0.0001 + 0.0002);
    expect(merged.costInUSD).toBeGreaterThan(0);
  });

  it('treats a missing cost as zero', () => {
    const merged = mergeUsage(
      { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      { ...getEmptyUsage(), costInUSD: 0.5 },
    );

    expect(merged.costInUSD).toBe(0.5);
  });
});

describe('cache read tokens', () => {
  const base = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

  it('reads either provider shape', () => {
    expect(resolveCacheReadTokens({ ...base, cache_read_input_tokens: 7 })).toBe(7);
    expect(resolveCacheReadTokens({ ...base, prompt_tokens_details: { cached_tokens: 7 } })).toBe(7);
  });

  it('does not double count a value reported under both names', () => {
    expect(
      resolveCacheReadTokens({ ...base, cache_read_input_tokens: 7, prompt_tokens_details: { cached_tokens: 7 } }),
    ).toBe(7);
  });

  it('ignores a zeroed peer field instead of preferring it', () => {
    const raw = { ...base, cache_read_input_tokens: 0, prompt_tokens_details: { cached_tokens: 40 } };

    expect(resolveCacheReadTokens(raw)).toBe(40);
    expect(resolveCacheReadTokens(mergeUsage(getEmptyUsage(), raw))).toBe(40);
  });

  it('distinguishes an unreported total from a reported zero', () => {
    expect(resolveCacheReadTokens(base)).toBeUndefined();
    expect(resolveCacheReadTokens({ ...base, cache_read_input_tokens: 0 })).toBe(0);
  });

  it('keeps OpenAI-shaped cache reads readable after merging', () => {
    // mergeUsage materializes cache_read_input_tokens, so resolving it must not stop at that 0.
    const merged = mergeUsage(getEmptyUsage(), { ...base, prompt_tokens_details: { cached_tokens: 9 } });

    expect(merged.cache_read_input_tokens).toBe(9);
    expect(resolveCacheReadTokens(merged)).toBe(9);
  });

  it('sums cache reads across mixed provider shapes and repeated merges', () => {
    const merged = mergeUsage(mergeUsage(getEmptyUsage(), { ...base, prompt_tokens_details: { cached_tokens: 9 } }), {
      ...base,
      cache_read_input_tokens: 4,
    });

    expect(resolveCacheReadTokens(merged)).toBe(13);
    // Re-merging an already-merged total must stay stable, not fold cached_tokens in twice.
    expect(resolveCacheReadTokens(mergeUsage(merged, getEmptyUsage()))).toBe(13);
  });
});
