import { CompletionUsageSchema, getEmptyUsage } from '../../src/core/llm/LLMTypes';
import { mergeUsage } from '../../src/core/llm/usage';

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
