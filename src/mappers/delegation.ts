/**
 * opencode-otel-plugin - Delegation Mapper
 * 
 * Handles agent-to-agent delegation detection and context package tracking.
 */

import { trace, SpanKind } from "@opentelemetry/api";
import type { Span } from "@opentelemetry/api";
import type { DelegationInfo, ContextPackage, ConversationContext, AgentInfo } from "../types.js";
import { createBaseAttributes, addDelegationAttributes, addContextPackageAttributes, flattenAttributes } from "../otel/semantic-conventions.js";
import { getConversationContext, generateConversationId, generateAgentId, createContextPackage, diffContextPackages } from "../utils/ids.js";
import { enrichSpanAttributes } from "../otel/provider.js";

// ─── Delegation Detection ─────────────────────────────────────────────────────

/**
 * Detect delegation from message parts
 * Called when a subtask part is detected in an assistant message
 */
export function detectDelegation(
  message: any,
  sessionId: string,
  convCtx: ConversationContext
): DelegationInfo | null {
  // Look for subtask parts in the message
  const parts = message.parts || [];
  const subtaskParts = parts.filter((p: any) => p.type === 'subtask');
  
  if (subtaskParts.length === 0) return null;

  // For now, handle first subtask (could be multiple)
  const subtask = subtaskParts[0];
  const { prompt, description, agent: subAgentName } = subtask;
  
  if (!subAgentName) return null;

  const conversationId = generateConversationId(sessionId);
  
  // Parent agent (delegator)
  const fromAgentId = convCtx.rootAgentId;
  const fromAgentName = convCtx.rootAgentName;
  
  // Child agent (delegatee)
  const toAgentId = generateAgentId(subAgentName, sessionId);
  const toAgentName = subAgentName;

  // Build context package from conversation history
  // This is a simplified version - real implementation would capture actual context
  const contextPackage = buildContextPackageFromConversation(convCtx, prompt);

  return {
    fromAgentId,
    fromAgentName,
    toAgentId,
    toAgentName,
    rationale: description,
    contextTokensSent: contextPackage.tokensSent,
    contextTokensReceived: contextPackage.tokensSent,
    truncated: contextPackage.truncated,
  };
}

/**
 * Build context package from conversation history
 */
function buildContextPackageFromConversation(
  convCtx: ConversationContext,
  currentPrompt: string
): ContextPackage {
  // In a real implementation, this would:
  // 1. Get the actual message history from opencode
  // 2. Calculate token counts
  // 3. Apply truncation logic based on model context window
  
  // For now, return a basic package
  return createContextPackage([
    { role: 'user', content: currentPrompt },
  ]);
}

/**
 * Update context package when sub-agent receives it
 */
export function updateContextPackageReceived(
  delegation: DelegationInfo,
  receivedTokens: number
): DelegationInfo {
  return {
    ...delegation,
    contextTokensReceived: receivedTokens,
    truncated: receivedTokens < (delegation.contextTokensSent ?? 0),
  };
}

/**
 * Create delegation spans (both delegator and delegatee)
 */
export function createDelegationSpans(
  delegation: DelegationInfo,
  sessionId: string,
  tracer: ReturnType<typeof trace.getTracer>,
  piiRedactor: any,
  agentRegistry: Map<string, AgentInfo>
): { delegatorSpan: Span; delegateeSpan: Span; contextSpan: Span } {
  const conversationId = generateConversationId(sessionId);
  
  // 1. Delegation span (on delegator)
  const delegatorSpan = tracer.startSpan(
    `delegation.${delegation.fromAgentName}->${delegation.toAgentName}`,
    {
      kind: SpanKind.CLIENT,
      attributes: flattenAttributes(createBaseAttributes(
        sessionId,
        delegation.fromAgentId,
        delegation.fromAgentName,
        conversationId,
        'delegation'
      )),
    }
  );

  const delegationAttrs = addDelegationAttributes({} as any, delegation);
  enrichSpanAttributes(delegatorSpan, delegationAttrs, piiRedactor);

  // 2. Delegatee agent span (invoke_agent for sub-agent)
  const delegateeSpan = tracer.startSpan(
    `agent.invoke.${delegation.toAgentName}`,
    {
      kind: SpanKind.CLIENT,
      attributes: flattenAttributes(createBaseAttributes(
        sessionId,
        delegation.toAgentId,
        delegation.toAgentName,
        conversationId,
        'agent.sub'
      )),
    }
  );

  // Add context package to delegatee span
  const contextPackage: ContextPackage = {
    tokensSent: delegation.contextTokensSent ?? 0,
    tokensReceived: delegation.contextTokensReceived ?? 0,
    truncated: delegation.truncated ?? false,
    messages: [], // Would be populated with actual messages
  };
  
  const contextAttrs = addContextPackageAttributes({} as any, contextPackage);
  enrichSpanAttributes(delegateeSpan, contextAttrs, piiRedactor);

  // 3. Context package span (for detailed tracking)
  const contextSpan = tracer.startSpan(
    `context.package.${delegation.fromAgentName}->${delegation.toAgentName}`,
    {
      kind: SpanKind.INTERNAL,
      attributes: flattenAttributes(createBaseAttributes(
        sessionId,
        delegation.fromAgentId,
        delegation.fromAgentName,
        conversationId,
        'delegation'
      )),
    }
  );

  enrichSpanAttributes(contextSpan, contextAttrs, piiRedactor);
  contextSpan.setAttribute('context.package.diff', diffContextPackages(contextPackage, contextPackage));

  // Register delegatee agent
  const delegateeInfo: AgentInfo = {
    id: delegation.toAgentId,
    name: delegation.toAgentName,
    description: delegation.rationale,
    parentId: delegation.fromAgentId,
    contextTokens: delegation.contextTokensReceived ?? 0,
    tools: [],
  };
  agentRegistry.set(delegation.toAgentId, delegateeInfo);

  return { delegatorSpan, delegateeSpan, contextSpan };
}

/**
 * Calculate context fidelity score for a handoff
 * fidelity = 1 - (tokens_dropped / tokens_available_at_sender)
 */
export function calculateContextFidelity(
  tokensSent: number,
  tokensReceived: number,
  maxContextTokens: number
): number {
  if (tokensSent === 0) return 1.0;
  const dropped = Math.max(0, tokensSent - tokensReceived);
  const available = Math.min(tokensSent, maxContextTokens);
  if (available === 0) return 1.0;
  return Math.max(0, 1 - dropped / available);
}

/**
 * Add context fidelity attributes to a span
 */
export function addContextFidelityAttributes(
  span: Span,
  fidelity: number,
  tokensSent: number,
  tokensReceived: number,
  maxContextTokens: number
): void {
  span.setAttribute('agent.context.fidelity', fidelity);
  span.setAttribute('agent.context.fidelity.percent', Math.round(fidelity * 100));
  span.setAttribute('agent.context.tokens_sent', tokensSent);
  span.setAttribute('agent.context.tokens_received', tokensReceived);
  span.setAttribute('agent.context.tokens_dropped', Math.max(0, tokensSent - tokensReceived));
  span.setAttribute('agent.context.max_tokens', maxContextTokens);
  
  // Alert threshold
  if (fidelity < 0.7) {
    span.setAttribute('agent.context.fidelity.alert', true);
    span.setAttribute('agent.context.fidelity.threshold', 0.7);
  }
}

// ─── Handoff Chain Tracking ───────────────────────────────────────────────────

/**
 * Track delegation chain for a conversation
 */
export function trackHandoffChain(
  convCtx: ConversationContext,
  delegation: DelegationInfo
): DelegationInfo[] {
  // Initialize delegation chain if not exists
  if (!convCtx.delegationChain) {
    convCtx.delegationChain = [];
  }
  
  convCtx.delegationChain.push(delegation);
  
  return convCtx.delegationChain;
}

/**
 * Get full handoff chain for a conversation
 */
export function getHandoffChain(convCtx: ConversationContext): DelegationInfo[] {
  return convCtx.delegationChain || [];
}

// ─── Export ───────────────────────────────────────────────────────────────────

export const delegationMapper = {
  detectDelegation,
  updateContextPackageReceived,
  createDelegationSpans,
  calculateContextFidelity,
  addContextFidelityAttributes,
  trackHandoffChain,
  getHandoffChain,
};