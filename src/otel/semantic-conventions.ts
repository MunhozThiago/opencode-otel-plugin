/**
 * opencode-otel-plugin - GenAI Semantic Conventions
 * 
 * Helper functions for OpenTelemetry GenAI Semantic Conventions v1.40+
 * Based on: https://github.com/open-telemetry/semantic-conventions/blob/main/docs/gen-ai/gen-ai-spans.md
 */

import type { Attributes, SpanKind } from "@opentelemetry/api";
import { SpanKind as APISpanKind } from "@opentelemetry/api";
import type { GenAIAttributes, SpanType, DelegationInfo, ContextPackage, MemoryOperation } from "../types.js";

// ─── Standard Span Kinds Mapping ──────────────────────────────────────────────

export function spanTypeToSpanKind(spanType: SpanType): SpanKind {
  switch (spanType) {
    case 'agent.root':
    case 'agent.sub':
    case 'delegation':
      return APISpanKind.CLIENT; // invoke_agent is typically CLIENT
    case 'chat':
      return APISpanKind.CLIENT; // Model inference
    case 'tool':
    case 'mcp.tool':
      return APISpanKind.CLIENT; // Tool execution
    case 'plan':
      return APISpanKind.INTERNAL; // Planning
    case 'memory.create':
    case 'memory.search':
    case 'memory.update':
    case 'memory.delete':
      return APISpanKind.INTERNAL; // Memory operations
    case 'workflow':
      return APISpanKind.INTERNAL; // Orchestration
    case 'session':
    case 'compaction':
      return APISpanKind.INTERNAL;
    case 'todo':
    case 'command':
    case 'file':
      return APISpanKind.INTERNAL; // Internal operations
    default:
      return APISpanKind.INTERNAL;
  }
}

export function spanTypeToOperationName(spanType: SpanType): string {
  switch (spanType) {
    case 'agent.root':
    case 'agent.sub':
    case 'delegation':
      return 'invoke_agent';
    case 'chat':
      return 'chat';
    case 'tool':
      return 'execute_tool';
    case 'mcp.tool':
      return 'execute_tool';
    case 'plan':
      return 'plan';
    case 'memory.create':
      return 'create_memory';
    case 'memory.search':
      return 'search_memory';
    case 'memory.update':
      return 'update_memory';
    case 'memory.delete':
      return 'delete_memory';
    case 'workflow':
      return 'invoke_workflow';
    case 'session':
      return 'session';
    case 'compaction':
      return 'create_memory';
    case 'todo':
      return 'todo';
    case 'command':
      return 'execute_command';
    case 'file':
      return 'file_operation';
    default:
      return 'unknown';
  }
}

// ─── Base Attributes Builder ──────────────────────────────────────────────────

export function createBaseAttributes(
  sessionId: string,
  agentId: string,
  agentName: string,
  conversationId: string,
  spanType: SpanType,
  options?: {
    agentVersion?: string;
    agentDescription?: string;
    sessionId?: string;
    workflowPattern?: string;
    projectId?: string;
  }
): GenAIAttributes {
  const base: GenAIAttributes = {
    'gen_ai.agent.id': agentId,
    'gen_ai.agent.name': agentName,
    'gen_ai.conversation.id': conversationId,
    'gen_ai.operation.name': spanTypeToOperationName(spanType),
    'gen_ai.agent.version': options?.agentVersion,
    'gen_ai.session.id': options?.sessionId ?? sessionId,
    'gen_ai.agent.description': options?.agentDescription,
    'agent.workflow.pattern': options?.workflowPattern,
  } as GenAIAttributes;
  // project.id common attribute (P2)
  if (options?.projectId) {
    (base as Record<string, unknown>)['project.id'] = options.projectId;
    (base as Record<string, unknown>)['session.project_id'] = options.projectId;
  }
  return base;
}

// ─── LLM/Chat Attributes ──────────────────────────────────────────────────────

export function addChatAttributes(
  attrs: GenAIAttributes,
  data: {
    requestModel: string;
    responseModel?: string;
    providerName: string;
    system: string;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  }
): GenAIAttributes {
  return {
    ...attrs,
    'gen_ai.request.model': data.requestModel,
    'gen_ai.response.model': data.responseModel ?? data.requestModel,
    'gen_ai.provider.name': data.providerName,
    'gen_ai.system': data.system,
    'gen_ai.token_usage.input': data.inputTokens,
    'gen_ai.token_usage.output': data.outputTokens,
    'gen_ai.token_usage.total': data.inputTokens + data.outputTokens + (data.reasoningTokens ?? 0) + (data.cacheReadTokens ?? 0) + (data.cacheWriteTokens ?? 0),
  };
}

// ─── Tool Attributes ──────────────────────────────────────────────────────────

export function addToolAttributes(
  attrs: GenAIAttributes,
  data: {
    toolName: string;
    toolCallId: string;
    input?: Record<string, unknown>;
    output?: string;
    error?: string;
    durationMs?: number;
    isMCP?: boolean;
    mcpServerName?: string;
    mcpSessionId?: string;
  }
): GenAIAttributes {
  const result = { ...attrs };
  
  // Tool name and call ID
  // Note: GenAI conventions use gen_ai.tool.name but we'll use standard attributes too
  (result as Record<string, unknown>)['gen_ai.tool.name'] = data.toolName;
  (result as Record<string, unknown>)['gen_ai.tool.call_id'] = data.toolCallId;
  
  if (data.input) {
    (result as Record<string, unknown>)['gen_ai.tool.input'] = JSON.stringify(data.input);
  }
  if (data.output) {
    (result as Record<string, unknown>)['gen_ai.tool.output'] = data.output;
  }
  if (data.error) {
    (result as Record<string, unknown>)['gen_ai.tool.error'] = data.error;
    result['gen_ai.operation.name'] = 'execute_tool'; // Ensure operation name is set
  }
  if (data.durationMs !== undefined) {
    (result as Record<string, unknown>)['gen_ai.tool.duration_ms'] = data.durationMs;
  }

  // OpenInference dual attributes for backend interop
  addOpenInferenceAttributes(result as GenAIAttributes, {
    operationName: 'execute_tool',
    toolName: data.toolName,
    toolCallId: data.toolCallId,
    toolParameters: data.input,
    outputText: data.output,
  });

  // MCP attributes
  if (data.isMCP) {
    result['mcp.method.name'] = data.toolName;
    if (data.mcpServerName) {
      result['mcp.server.name'] = data.mcpServerName;
    }
    if (data.mcpSessionId) {
      result['mcp.session.id'] = data.mcpSessionId;
    }
  }

  return result;
}

// ─── OpenInference dual attributes (P2 backend interop) ───────────────────────
// Map GenAI semconv → OpenInference so Arize/Phoenix and other OI backends
// can ingest the same spans without a separate exporter.

export const OPENINFERENCE = {
  OPERATION_NAME: 'openinference.span.kind',
  MODEL_NAME: 'llm.model_name',
  PROVIDER: 'llm.provider',
  INPUT_MESSAGES: 'llm.input_messages',
  OUTPUT_MESSAGES: 'llm.output_messages',
  INPUT_TOKENS: 'llm.token_count.prompt',
  OUTPUT_TOKENS: 'llm.token_count.completion',
  TOTAL_TOKENS: 'llm.token_count.total',
  TOOL_NAME: 'tool.name',
  TOOL_CALL_ID: 'tool.call_id',
  TOOL_PARAMETERS: 'tool.parameters',
  RETRIEVAL_DOCUMENTS: 'retrieval.documents',
  METADATA: 'metadata',
} as const;

/** Map gen_ai span kind / operation → OpenInference.span.kind */
export function openInferenceSpanKind(operationName: string): string {
  switch (operationName) {
    case 'chat':
      return 'LLM';
    case 'execute_tool':
      return 'TOOL';
    case 'invoke_agent':
    case 'invoke_workflow':
      return 'AGENT';
    case 'create_memory':
    case 'search_memory':
    case 'update_memory':
    case 'delete_memory':
      return 'RETRIEVER';
    case 'plan':
    case 'session':
    case 'todo':
    case 'execute_command':
    case 'file_operation':
      return 'CHAIN';
    default:
      return 'UNKNOWN';
  }
}

/**
 * Add OpenInference dual attributes alongside existing GenAI attrs.
 * Returns the same object mutated (attributes are flat key/value).
 */
export function addOpenInferenceAttributes(
  attrs: GenAIAttributes,
  data?: {
    operationName?: string;
    modelName?: string;
    providerName?: string;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    toolName?: string;
    toolCallId?: string;
    toolParameters?: Record<string, unknown> | string;
    inputText?: string;
    outputText?: string;
  }
): GenAIAttributes {
  const out = attrs as Record<string, unknown>;
  const op =
    data?.operationName ??
    (typeof out['gen_ai.operation.name'] === 'string'
      ? (out['gen_ai.operation.name'] as string)
      : undefined);

  if (op) {
    out[OPENINFERENCE.OPERATION_NAME] = openInferenceSpanKind(op);
  }

  const model =
    data?.modelName ??
    (typeof out['gen_ai.request.model'] === 'string'
      ? (out['gen_ai.request.model'] as string)
      : undefined);
  if (model) out[OPENINFERENCE.MODEL_NAME] = model;

  const provider =
    data?.providerName ??
    (typeof out['gen_ai.provider.name'] === 'string'
      ? (out['gen_ai.provider.name'] as string)
      : undefined);
  if (provider) out[OPENINFERENCE.PROVIDER] = provider;

  const inputTokens =
    data?.inputTokens ??
    (typeof out['gen_ai.token_usage.input'] === 'number'
      ? (out['gen_ai.token_usage.input'] as number)
      : undefined);
  if (inputTokens !== undefined) out[OPENINFERENCE.INPUT_TOKENS] = inputTokens;

  const outputTokens =
    data?.outputTokens ??
    (typeof out['gen_ai.token_usage.output'] === 'number'
      ? (out['gen_ai.token_usage.output'] as number)
      : undefined);
  if (outputTokens !== undefined) out[OPENINFERENCE.OUTPUT_TOKENS] = outputTokens;

  const totalTokens =
    data?.totalTokens ??
    (typeof out['gen_ai.token_usage.total'] === 'number'
      ? (out['gen_ai.token_usage.total'] as number)
      : undefined);
  if (totalTokens !== undefined) out[OPENINFERENCE.TOTAL_TOKENS] = totalTokens;

  const toolName =
    data?.toolName ??
    (typeof out['gen_ai.tool.name'] === 'string'
      ? (out['gen_ai.tool.name'] as string)
      : undefined);
  if (toolName) out[OPENINFERENCE.TOOL_NAME] = toolName;

  const toolCallId =
    data?.toolCallId ??
    (typeof out['gen_ai.tool.call_id'] === 'string'
      ? (out['gen_ai.tool.call_id'] as string)
      : undefined);
  if (toolCallId) out[OPENINFERENCE.TOOL_CALL_ID] = toolCallId;

  if (data?.toolParameters !== undefined) {
    out[OPENINFERENCE.TOOL_PARAMETERS] =
      typeof data.toolParameters === 'string'
        ? data.toolParameters
        : JSON.stringify(data.toolParameters);
  } else if (typeof out['gen_ai.tool.input'] === 'string') {
    out[OPENINFERENCE.TOOL_PARAMETERS] = out['gen_ai.tool.input'];
  }

  if (data?.inputText !== undefined) {
    out[`${OPENINFERENCE.INPUT_MESSAGES}.0.message.content`] = data.inputText;
  }
  if (data?.outputText !== undefined) {
    out[`${OPENINFERENCE.OUTPUT_MESSAGES}.0.message.content`] = data.outputText;
  } else if (typeof out['gen_ai.tool.output'] === 'string') {
    out[`${OPENINFERENCE.OUTPUT_MESSAGES}.0.message.content`] = out['gen_ai.tool.output'];
  }

  return attrs;
}

export function addDelegationAttributes(
  attrs: GenAIAttributes,
  delegation: DelegationInfo
): GenAIAttributes {
  return {
    ...attrs,
    'agent.delegation.rationale': delegation.rationale,
    'agent.delegation.from_agent_id': delegation.fromAgentId,
    'agent.delegation.to_agent_id': delegation.toAgentId,
    'agent.context.package.tokens_sent': delegation.contextTokensSent,
    'agent.context.package.tokens_received': delegation.contextTokensReceived,
    'agent.context.package.truncated': delegation.truncated ?? false,
  };
}

// ─── Context Package Attributes ───────────────────────────────────────────────

export function addContextPackageAttributes(
  attrs: GenAIAttributes,
  contextPackage: ContextPackage
): GenAIAttributes {
  return {
    ...attrs,
    'agent.context.package.tokens_sent': contextPackage.tokensSent,
    'agent.context.package.tokens_received': contextPackage.tokensReceived,
    'agent.context.package.truncated': contextPackage.truncated,
    'agent.context.package.diff': contextPackage.diff,
  };
}

// ─── Memory Attributes ────────────────────────────────────────────────────────

export function addMemoryAttributes(
  attrs: GenAIAttributes,
  memoryOp: MemoryOperation
): GenAIAttributes {
  return {
    ...attrs,
    'agent.memory.operation': memoryOp.operation,
    'agent.memory.key': memoryOp.keyHash, // Store hash, not raw key
    'agent.memory.version': memoryOp.version,
  };
}

// ─── Context Window Attributes ────────────────────────────────────────────────

export function addContextWindowAttributes(
  attrs: GenAIAttributes,
  data: {
    fillPercent: number;
    tokensAvailable: number;
    tokensUsed: number;
    maxTokens: number;
  }
): GenAIAttributes {
  return {
    ...attrs,
    'agent.context.window.fill_percent': data.fillPercent,
    'agent.context.window.tokens_available': data.tokensAvailable,
    'agent.context.window.tokens_used': data.tokensUsed,
    'agent.context.window.max_tokens': data.maxTokens,
  };
}

// ─── Error Attributes ─────────────────────────────────────────────────────────

export function addErrorAttributes(
  attrs: Attributes,
  error: Error | string,
  type?: string
): Attributes {
  const err = error instanceof Error ? error : new Error(String(error));
  return {
    ...attrs,
    'error.type': type ?? err.name,
    'error.message': err.message,
    'error.stack': err.stack,
  };
}

// ─── Session Attributes ───────────────────────────────────────────────────────

export function addSessionAttributes(
  attrs: GenAIAttributes,
  data: {
    sessionId: string;
    title?: string;
    projectId?: string;
    directory?: string;
    parentSessionId?: string;
  }
): GenAIAttributes {
  return {
    ...attrs,
    'session.id': data.sessionId,
    'session.title': data.title,
    'session.project_id': data.projectId,
    'session.directory': data.directory,
    'session.parent_id': data.parentSessionId,
  };
}

// ─── Utility: Flatten Attributes for OTel ─────────────────────────────────────

export function flattenAttributes(attrs: GenAIAttributes): Attributes {
  const result: Attributes = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined && value !== null) {
      result[key] = value;
    }
  }
  return result;
}

// ─── Export ───────────────────────────────────────────────────────────────────

export const GEN_AI_SPAN_KINDS = {
  INVOKE_AGENT: 'invoke_agent',
  PLAN: 'plan',
  EXECUTE_TOOL: 'execute_tool',
  CREATE_MEMORY: 'create_memory',
  SEARCH_MEMORY: 'search_memory',
  UPDATE_MEMORY: 'update_memory',
  DELETE_MEMORY: 'delete_memory',
  RETRIEVAL: 'retrieval',
  CHAT: 'chat',
  GENERATE_CONTENT: 'generate_content',
  TEXT_COMPLETION: 'text_completion',
  INVOKE_WORKFLOW: 'invoke_workflow',
} as const;

export const GEN_AI_ATTRIBUTES = {
  AGENT_ID: 'gen_ai.agent.id',
  AGENT_NAME: 'gen_ai.agent.name',
  AGENT_VERSION: 'gen_ai.agent.version',
  AGENT_DESCRIPTION: 'gen_ai.agent.description',
  CONVERSATION_ID: 'gen_ai.conversation.id',
  SESSION_ID: 'gen_ai.session.id',
  OPERATION_NAME: 'gen_ai.operation.name',
  REQUEST_MODEL: 'gen_ai.request.model',
  RESPONSE_MODEL: 'gen_ai.response.model',
  PROVIDER_NAME: 'gen_ai.provider.name',
  SYSTEM: 'gen_ai.system',
  TOKEN_USAGE_INPUT: 'gen_ai.token_usage.input',
  TOKEN_USAGE_OUTPUT: 'gen_ai.token_usage.output',
  TOKEN_USAGE_TOTAL: 'gen_ai.token_usage.total',
  TOOL_NAME: 'gen_ai.tool.name',
  TOOL_CALL_ID: 'gen_ai.tool.call_id',
  TOOL_INPUT: 'gen_ai.tool.input',
  TOOL_OUTPUT: 'gen_ai.tool.output',
  TOOL_ERROR: 'gen_ai.tool.error',
  TOOL_DURATION_MS: 'gen_ai.tool.duration_ms',
  MCP_METHOD_NAME: 'mcp.method.name',
  MCP_SESSION_ID: 'mcp.session.id',
  MCP_SERVER_NAME: 'mcp.server.name',
} as const;