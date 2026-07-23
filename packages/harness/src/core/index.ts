/**
 * Public agent execution harness.
 * Intentional consumer-facing exports only (production API).
 */

// Runtime
export type { AgentDefinition } from './runtime/AgentDefinition';
export { AgentThread } from './runtime/AgentThread';
export type { AgentInfo, AgentParent } from './runtime/AgentThread.types';
export { AgentThreadOrchestrator } from './runtime/AgentThreadOrchestrator';
export type { CreateDynamicSubAgentThread } from './runtime/CreateDynamicSubAgentThread';
export { isAgentInputUserMessage, isEmptyMessageContent, isFileContentPart } from './runtime/UserInputMessage';
export type { AgentInputUserMessage } from './runtime/UserInputMessage';

// Capability contracts
export type { AgentCapability } from './capabilities/AgentCapability';
export type {
  AgentContextProcessorOutput,
  AgentThreadExecutionContext,
  PostToolCallAgentContextProcessor,
  PreLLMEphemeralAgentContextProcessor,
} from './capabilities/AgentContextProcessor';

// Built-in factories
export { askUserQuestion } from './capabilities/builtins/AskUserQuestion';
export { contextCompaction } from './capabilities/builtins/ContextCompaction';
export { currentDateTime } from './capabilities/builtins/CurrentDateTime';
export { SUB_AGENT_IDENTITY, dynamicSubAgents } from './capabilities/builtins/DynamicSubAgents';
export { largeToolResponse } from './capabilities/builtins/LargeToolResponse';
export { openUI } from './capabilities/builtins/OpenUI';

// MCP contracts
export type { ApprovalDecision } from './events/eventSchemas';
export { ClientSideTool } from './mcp/ClientSideTool';
export { isAuthRequired, toolResultResponse } from './mcp/IMCPServer';
export type {
  AgentToolSchema,
  AuthRequiredResponse,
  CallToolResponse,
  IToolSet,
  ListToolsResponse,
  MCPAuthRequired,
  ToolSource,
} from './mcp/IMCPServer';
export { LocalToolMCP, defineTool } from './mcp/LocalToolMCP';
export type { ToolDefinition } from './mcp/LocalToolMCP';

// Remote MCP server, split into a shared, policy-free connection (`RemoteMCP`) and a per-agent policy
// wrapper (`ToolSet`). `RemoteMCP` connects itself from a `url` + `headers`; the networking helpers
// live in the harness-internal `remoteMcpClient` module.
export { RemoteMCP } from './mcp/RemoteMCP';
export type { RemoteMcpHeaders, ResolveHeadersResult } from './mcp/RemoteMCP';
export type { RemoteMcpConnection, RemoteMcpTransportType } from './mcp/remoteMcpClient';
export type { ToolSelectorConfig } from './mcp/ToolSelectorPolicy';
export { ToolSet } from './mcp/ToolSet';

// LLM contracts
export type { ILLM } from './llm/ILLM';
export { OpenAILLM } from './llm/OpenAILLM';
export { ResponseFormatSchema, toOpenAIResponseFormat } from './llm/responseFormat';
export type { ResponseFormat } from './llm/responseFormat';

// Event contracts
export {
  EventType,
  MCPAuthRequiredEventSchema,
  MCPInitializeEventSchema,
  ModelMessageDeltaEventSchema,
  ModelMessageEventSchema,
  SandboxCreatedEventSchema,
  ThreadCreatedEventSchema,
  ThreadDoneEventSchema,
  ToolApprovalRequiredEventSchema,
  ToolResponseEventSchema,
  ToolResponseRequiredEventSchema,
  newEventId,
} from './events/eventSchemas';
export type { AgentThreadMetric } from './llm/metrics';
export { InternalEventType } from './runtime/AgentThread.types';
export type { AgentThreadSendBatch, ContextMessage } from './runtime/AgentThread.types';
export type { SandboxInfo } from './sandbox/Sandbox';

// Tracing
export type {
  AgentExecutionTrace,
  AgentLocalToolTrace,
  AgentRemoteMcpToolTrace,
  AgentTracing,
} from './tracing/AgentTracing';

// Errors / utils
export { AgentHarnessError, McpConnectionError } from './errors';
export { extractErrorLogFields } from './util/errorLogFields';

// Sandbox (concrete implementation; provider details exported for composition)
export {
  DaytonaSandboxProviderSettingsSchema,
  SandboxProviderSettingsSchema,
  createSandboxProvider,
} from './sandbox/provider/createSandboxProvider';
export type { CreateSandboxProviderInput, SandboxProviderSettings } from './sandbox/provider/createSandboxProvider';
export { DaytonaSandboxProvider } from './sandbox/provider/DaytonaProvider';
export type { SandboxProvider } from './sandbox/provider/Provider';
export { TFYSandboxProvider } from './sandbox/provider/TFYSandboxProvider';
export { Sandbox } from './sandbox/Sandbox';

/*
 * ============================================================================
 * Gateway compatibility exports
 * ============================================================================
 * Added when the gateway migrated from its in-tree harness copy to this
 * package. Every export below was something the gateway imported via deep
 * paths; they are classified into three tiers. The tiers are the OSS-readiness
 * worklist: before the public release, tier 1 gets folded into the curated
 * sections above, and tiers 2–3 must shrink to zero.
 */

/*
 * --- Tier 1: genuine host API -----------------------------------------------
 * Contracts any host embedding the harness legitimately needs: the event wire
 * format it streams/persists, the inputs it sends to a thread, observability
 * types, and configuration surface (defaults, selector tags, sandbox config).
 * TODO(oss): merge into the curated sections above.
 */

// Event wire contract (streamed to clients / persisted by the host).
export {
  ActionRequiredEventSchema,
  AgentInputUserMessageSchema,
  EventIdSchema,
  ThreadOverwriteContextEventSchema,
  UserToolApprovalMessageSchema,
  UserToolResponseMessageSchema,
} from './events/eventSchemas';
export type {
  AgentOutputEvent,
  MCPAuthRequiredEvent,
  MCPServerAuthInfo,
  MCPServerInitInfo,
  ThreadDoneEvent,
  ThreadOverwriteContextEvent,
} from './events/eventSchemas';

// Host -> thread interaction types.
export type {
  AgentSendInput,
  AgentThreadAppendContext,
  AgentThreadCreateSubAgent,
  AgentThreadEvent,
  AgentThreadExecutionEvent,
  AgentThreadExecutionResult,
  SubAgentCompletionMarker,
} from './runtime/AgentThread.types';

// Observability.
export type { AgentMetadata } from './llm/ILLM';
export type { AgentThreadMetrics } from './llm/metrics';

// Configuration surface: tool-selector defaults/tags and builtin thresholds
// hosts mirror in their own spec/schema layers.
export { DEFAULT_CONTEXT_COMPACTION_THRESHOLD_TOKENS } from './capabilities/builtins/ContextCompaction';
export {
  DEFAULT_INDIVIDUAL_TOOL_TOKEN_THRESHOLD,
  DEFAULT_PREVIEW_NUMBER_OF_CHARACTERS,
  DEFAULT_TOTAL_TOOL_TOKEN_THRESHOLD,
} from './capabilities/builtins/LargeToolResponse';
export {
  DEFAULT_DISABLE_TOOLS,
  DEFAULT_ENABLE_TOOLS,
  DEFAULT_PRELOAD_TOOLS,
  DEFAULT_REQUIRE_APPROVAL_FOR_TOOLS,
  REQUIRE_APPROVAL_TOOLS_SELECTOR_TAGS,
  TOOLS_SELECTOR_TAGS,
} from './mcp/toolSelectors';

// Sandbox configuration types and error base class.
export type { DaytonaSandboxSettings } from './sandbox/provider/DaytonaProvider';
export type { MountedSkill } from './sandbox/Sandbox';
export { SandboxError } from './sandbox/SandboxErrors';

/*
 * --- Tier 2: needs review ----------------------------------------------------
 * The gateway uses these today, but ownership is unclear: each likely belongs
 * behind a harness API rather than in the export surface. Review per-symbol
 * before the public release.
 * TODO(oss): resolve each item (move behind an API or promote to tier 1).
 */

// Used by the gateway to construct sandbox providers itself; should disappear
// once provider construction is fully behind createSandboxProvider().
export { SANDBOX_NATS_WS_PORT } from './sandbox/constants';

// Used by the gateway's file-download handler; these guards belong behind the
// Sandbox file APIs (upload/download should validate internally).
export { validateNoPathTraversal, validateSandboxOwnedByTenant } from './sandbox/SandboxErrors';

// Persistence-facing context type; belongs to a future thread-state
// snapshot/hydration API (see tier 3).
export type { LLMContextMessage } from './runtime/AgentThread.types';

// OpenAI request/chunk Zod schemas the gateway re-exports for its own request
// validation. Either curate a stable schema module or let the gateway own its
// validation schemas.
export * from './llm/openaiSchemas';

/*
 * --- Tier 3: harness internals the gateway must stop using -------------------
 * Exported only because the gateway persists/replays harness thread state by
 * manipulating internal message representations directly (Redis replay,
 * session hydration, sub-agent orchestration). A host should never see these.
 * The planned replacement is an explicit thread-state serialization/hydration
 * API on AgentThread; once the gateway migrates to it, delete this section.
 * TODO(oss): remove after the persistence API lands. Do NOT add new consumers.
 */

// Internal LLM message representations (Internal* enriched messages, extended
// chunk deltas, finish reasons, ...). The gateway re-exports this whole module.
export * from './llm/LLMTypes';

// Prompt-construction internals: system-tag framing and internal message
// predicates the gateway uses while assembling/inspecting thread context.
export {
  SYSTEM_TAG_START,
  internalSystemMessage,
  isApprovalDecisionMessage,
  isClientSideToolResponseMessage,
} from './runtime/contextUtils';

// Internal thread-event shapes (pre-projection counterparts of the tier-1
// wire events) used by the gateway's orchestration/persistence glue.
export type {
  InternalMCPAuthRequiredEvent,
  InternalMCPServerAuthInfo,
  InternalThreadDoneEvent,
} from './runtime/AgentThread.types';
