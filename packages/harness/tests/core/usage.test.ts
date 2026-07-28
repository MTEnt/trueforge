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
    expect(merged.costInUSD).toBeCloseTo(0.35);
  });
});
