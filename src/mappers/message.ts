/**
 * opencode-otel-plugin - Message Event Mapper
 * 
 * Maps opencode message events to OpenTelemetry spans (LLM inferences, delegations).
 */

import { trace, SpanKind } from "@opentelemetry/api";
import type { Span, Context } from "@opentelemetry/api";
import type { MessageEvent, MessagePartEvent } from "../types.js";
import type { GenAIAttributes, SpanMetadata, AgentInfo, ConversationContext, ContextPackage, DelegationInfo } from "../types.js";
import { createBaseAttributes, addChatAttributes, addDelegationAttributes, addContextPackageAttributes, addToolAttributes, flattenAttributes, spanTypeToSpanKind, addOpenInferenceAttributes } from "../otel/semantic-conventions.js";
import { getOrCreateConversationContext, getConversationContext, generateAgentId, generateConversationId, createContextPackage, diffContextPackages, estimateTokens } from "../utils/ids.js";
import { enrichSpanAttributes } from "../otel/provider.js";

// ─── Message Updated (Assistant Message = LLM Call) ─────────────────────────────

export function mapMessageUpdated(
  event: MessageEvent,
  tracer: ReturnType<typeof trace.getTracer>,
  piiRedactor: any,
  activeSpans: Map<string, Span>,
  agentRegistry: Map<string, AgentInfo>
): Span | null {
  const message = (event as any).properties?.info;
  if (!message) return null;

  // Only process assistant messages (LLM responses)
  if (message.role !== 'assistant') return null;

  const sessionId = message.sessionID;
  const conversationId = generateConversationId(sessionId);
  const convCtx = getOrCreateConversationContext(conversationId, sessionId, '', '');
  
  // Determine agent - use message.agent or fall back to root agent
  const agentName = message.agent || convCtx.rootAgentName || 'primary';
  const agentId = generateAgentId(agentName, sessionId);

  // Get or create agent info
  let agentInfo = agentRegistry.get(agentId);
  if (!agentInfo) {
    agentInfo = {
      id: agentId,
      name: agentName,
      model: message.modelID,
      provider: message.providerID,
      tools: [],
      contextTokens: 0,
    };
    agentRegistry.set(agentId, agentInfo);
    convCtx.agents.set(agentId, agentInfo);
  }

  // Create chat span for LLM inference
  const spanName = `chat.${agentName}`;
  const span = tracer.startSpan(spanName, {
    kind: SpanKind.CLIENT,
    attributes: flattenAttributes(createBaseAttributes(sessionId, agentId, agentName, conversationId, 'chat', {
      agentDescription: agentInfo.description,
      sessionId,
    })),
  });

  // Add chat attributes from message
  const tokens = message.tokens || { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
  const chatAttrs = addChatAttributes(
    {} as GenAIAttributes,
    {
      requestModel: message.modelID,
      responseModel: message.modelID,
      providerName: message.providerID,
      system: message.providerID, // e.g., 'openai', 'anthropic'
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      reasoningTokens: tokens.reasoning,
      cacheReadTokens: tokens.cache?.read,
      cacheWriteTokens: tokens.cache?.write,
    }
  );
  // OpenInference dual attributes (Arize/Phoenix interop)
  addOpenInferenceAttributes(chatAttrs, {
    operationName: 'chat',
    modelName: message.modelID,
    providerName: message.providerID,
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    totalTokens: tokens.input + tokens.output + (tokens.reasoning || 0),
  });
  enrichSpanAttributes(span, chatAttrs, piiRedactor);

  // Add cost if available
  if (message.cost !== undefined) {
    span.setAttribute('gen_ai.cost', message.cost);
  }

  // Add finish reason
  if (message.finish) {
    span.setAttribute('gen_ai.response.finish_reason', message.finish);
  }

  // Check for subtask parts (delegation)
  // This would be handled in message.part.updated for subtask parts

  // Store span reference
  agentInfo.span = span;
  activeSpans.set(`${conversationId}:chat:${message.id}`, span);

  return span;
}

// ─── Message Part Updated (Tool calls, Subtasks, etc.) ─────────────────────────

export function mapMessagePartUpdated(
  event: MessagePartEvent,
  tracer: ReturnType<typeof trace.getTracer>,
  piiRedactor: any,
  activeSpans: Map<string, Span>,
  agentRegistry: Map<string, AgentInfo>
): Span | null {
  const { part, delta } = (event as any).properties || {};
  if (!part) return null;

  const sessionId = part.sessionID;
  const conversationId = generateConversationId(sessionId);
  const convCtx = getOrCreateConversationContext(conversationId, sessionId, '', '');

  switch (part.type) {
    case 'tool':
      return mapToolPart(part, tracer, piiRedactor, activeSpans, agentRegistry, convCtx);
    
    case 'subtask':
      return mapSubtaskPart(part, tracer, piiRedactor, activeSpans, agentRegistry, convCtx);
    
    case 'step-start':
      return mapStepStartPart(part, tracer, piiRedactor, activeSpans, convCtx);
    
    case 'step-finish':
      return mapStepFinishPart(part, tracer, piiRedactor, activeSpans, convCtx);
    
    default:
      return null;
  }
}

// ─── Tool Part Mapping ────────────────────────────────────────────────────────

function mapToolPart(
  part: any,
  tracer: ReturnType<typeof trace.getTracer>,
  piiRedactor: any,
  activeSpans: Map<string, Span>,
  agentRegistry: Map<string, AgentInfo>,
  convCtx: ConversationContext
): Span | null {
  const { callID, tool, state, metadata } = part;
  if (!callID || !tool) return null;

  const sessionId = part.sessionID;
  const conversationId = generateConversationId(sessionId);
  
  // Determine agent from message context (would need message lookup)
  // For now, use root agent
  const agentId = convCtx.rootAgentId;
  const agentName = convCtx.rootAgentName;
  const agentInfo = agentRegistry.get(agentId);

  const isMCP = tool.startsWith('mcp__') || tool.startsWith('mcp.');

  if (state.status === 'pending' || state.status === 'running') {
    // Start tool span
    const spanName = `tool.${tool}`;
    const span = tracer.startSpan(spanName, {
      kind: SpanKind.CLIENT,
      attributes: flattenAttributes(createBaseAttributes(sessionId, agentId, agentName, conversationId, isMCP ? 'mcp.tool' : 'tool')),
    });

    // Add tool attributes
    const toolAttrs = addToolAttributes(
      {} as GenAIAttributes,
      {
        toolName: tool,
        toolCallId: callID,
        input: state.input,
        isMCP,
        mcpServerName: metadata?.server,
        mcpSessionId: metadata?.sessionId,
      }
    );
    enrichSpanAttributes(span, toolAttrs, piiRedactor);

    // Store for completion
    activeSpans.set(`${conversationId}:tool:${callID}`, span);
    return span;
  } else if (state.status === 'completed' || state.status === 'error') {
    // Complete existing tool span
    const span = activeSpans.get(`${conversationId}:tool:${callID}`);
    if (span) {
      const toolAttrs = addToolAttributes(
        {} as GenAIAttributes,
        {
          toolName: tool,
          toolCallId: callID,
          output: state.output,
          error: state.error,
          durationMs: state.time?.end && state.time?.start 
            ? state.time.end - state.time.start 
            : undefined,
          isMCP,
          mcpServerName: metadata?.server,
          mcpSessionId: metadata?.sessionId,
        }
      );
      enrichSpanAttributes(span, toolAttrs, piiRedactor);
      
      if (state.status === 'error') {
        span.setAttribute('error', true);
        span.setAttribute('error.message', state.error || 'Unknown error');
      }
      
      span.end();
      activeSpans.delete(`${conversationId}:tool:${callID}`);
      return span;
    }
  }

  return null;
}

// ─── Subtask Part Mapping (Delegation) ────────────────────────────────────────

function mapSubtaskPart(
  part: any,
  tracer: ReturnType<typeof trace.getTracer>,
  piiRedactor: any,
  activeSpans: Map<string, Span>,
  agentRegistry: Map<string, AgentInfo>,
  convCtx: ConversationContext
): Span | null {
  const { prompt, description, agent: subAgentName } = part;
  if (!subAgentName) return null;

  const sessionId = part.sessionID;
  const conversationId = generateConversationId(sessionId);
  
  // Parent agent (delegator)
  const fromAgentId = convCtx.rootAgentId;
  const fromAgentName = convCtx.rootAgentName;
  
  // Child agent (delegatee)
  const toAgentId = generateAgentId(subAgentName, sessionId);
  const toAgentName = subAgentName;

  // Create delegation span
  const spanName = `delegation.${fromAgentName}->${toAgentName}`;
  const span = tracer.startSpan(spanName, {
    kind: SpanKind.CLIENT, // invoke_agent
    attributes: flattenAttributes(createBaseAttributes(sessionId, fromAgentId, fromAgentName, conversationId, 'delegation')),
  });

  // Build context package from current conversation
  // This is a simplified version - real implementation would capture actual context
  const contextPackage = createContextPackage([
    { role: 'user', content: prompt },
    { role: 'assistant', content: description },
  ]);

  // Add delegation attributes
  const delegation: DelegationInfo = {
    fromAgentId,
    fromAgentName,
    toAgentId,
    toAgentName,
    rationale: description,
    contextTokensSent: contextPackage.tokensSent,
    contextTokensReceived: contextPackage.tokensSent, // Will update when sub-agent receives
    truncated: contextPackage.truncated,
  };
  
  const delegationAttrs = addDelegationAttributes({} as GenAIAttributes, delegation);
  enrichSpanAttributes(span, delegationAttrs, piiRedactor);

  // Create sub-agent info
  const subAgentInfo: AgentInfo = {
    id: toAgentId,
    name: toAgentName,
    description,
    parentId: fromAgentId,
    contextTokens: contextPackage.tokensReceived,
    tools: [],
  };
  agentRegistry.set(toAgentId, subAgentInfo);
  convCtx.agents.set(toAgentId, subAgentInfo);

  // Store span
  activeSpans.set(`${conversationId}:delegation:${toAgentId}`, span);
  
  // Also create an invoke_agent span for the sub-agent
  const subAgentSpan = tracer.startSpan(`agent.invoke.${toAgentName}`, {
    kind: SpanKind.CLIENT,
    attributes: flattenAttributes(createBaseAttributes(sessionId, toAgentId, toAgentName, conversationId, 'agent.sub', {
      agentDescription: description,
      sessionId,
    })),
  });
  
  // Add context package to sub-agent span
  const contextAttrs = addContextPackageAttributes({} as GenAIAttributes, contextPackage);
  enrichSpanAttributes(subAgentSpan, contextAttrs, piiRedactor);
  
  subAgentInfo.span = subAgentSpan;
  activeSpans.set(`${conversationId}:agent:${toAgentId}`, subAgentSpan);

  return span;
}

// ─── Step Start/Finish Parts ──────────────────────────────────────────────────

function mapStepStartPart(
  part: any,
  tracer: ReturnType<typeof trace.getTracer>,
  piiRedactor: any,
  activeSpans: Map<string, Span>,
  convCtx: ConversationContext
): Span | null {
  const sessionId = part.sessionID;
  const conversationId = generateConversationId(sessionId);
  const agentId = convCtx.rootAgentId;
  const agentName = convCtx.rootAgentName;

  const spanName = `plan.step`;
  const span = tracer.startSpan(spanName, {
    kind: SpanKind.INTERNAL,
    attributes: flattenAttributes(createBaseAttributes(sessionId, agentId, agentName, conversationId, 'plan')),
  });

  if (part.snapshot) {
    span.setAttribute('plan.snapshot', part.snapshot);
  }

  enrichSpanAttributes(span, {} as GenAIAttributes, piiRedactor);
  activeSpans.set(`${conversationId}:step:${part.id}`, span);
  return span;
}

function mapStepFinishPart(
  part: any,
  tracer: ReturnType<typeof trace.getTracer>,
  piiRedactor: any,
  activeSpans: Map<string, Span>,
  convCtx: ConversationContext
): Span | null {
  const sessionId = part.sessionID;
  const conversationId = generateConversationId(sessionId);
  const agentId = convCtx.rootAgentId;
  const agentName = convCtx.rootAgentName;

  const span = activeSpans.get(`${conversationId}:step:${part.id}`);
  if (span) {
    span.setAttribute('plan.reason', part.reason);
    span.setAttribute('plan.cost', part.cost);
    span.setAttribute('gen_ai.token_usage.input', part.tokens?.input || 0);
    span.setAttribute('gen_ai.token_usage.output', part.tokens?.output || 0);
    span.setAttribute('gen_ai.token_usage.total', (part.tokens?.input || 0) + (part.tokens?.output || 0));
    
    if (part.snapshot) {
      span.setAttribute('plan.snapshot', part.snapshot);
    }

    enrichSpanAttributes(span, {} as GenAIAttributes, piiRedactor);
    span.end();
    activeSpans.delete(`${conversationId}:step:${part.id}`);
    return span;
  }

  return null;
}

// ─── Export ───────────────────────────────────────────────────────────────────

export const messageMapper = {
  updated: mapMessageUpdated,
  partUpdated: mapMessagePartUpdated,
};