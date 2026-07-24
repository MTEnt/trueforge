import type { CompletionUsage } from '../llm/LLMTypes';
import { getEmptyUsage } from '../llm/LLMTypes';
import { mergeUsage } from '../llm/usage';

export interface AgentThreadMetrics {
  iterations: number;
  total_tool_calls: number;
  total_summarizations: number;
  usage: CompletionUsage;
  total_sub_agents: number;
}

export function createEmptyAgentThreadMetrics(): AgentThreadMetrics {
  return {
    iterations: 0,
    total_tool_calls: 0,
    total_summarizations: 0,
    usage: getEmptyUsage(),
    total_sub_agents: 0,
  };
}

export function addAgentThreadMetrics(target: AgentThreadMetrics, source: AgentThreadMetrics): void {
  target.iterations += source.iterations;
  target.total_tool_calls += source.total_tool_calls;
  target.total_summarizations += source.total_summarizations;
  target.total_sub_agents += source.total_sub_agents;
  target.usage = mergeUsage(target.usage, source.usage);
}
