/**
 * opencode-otel-plugin - Utility Functions
 * 
 * ID generation, hashing, and context window utilities.
 */

import { trace, context } from "@opentelemetry/api";
import type { Span, Context } from "@opentelemetry/api";
import type { AgentInfo, ContextPackage, ConversationContext } from "../types.js";

// ─── Stable ID Generation ──────────────────────────────────────────────────────

/**
 * Generate a stable agent ID from agent name and session
 */
export function generateAgentId(agentName: string, sessionId: string): string {
  // Use a hash of agent name + session for stability across restarts
  let hash = 0;
  const str = `${agentName}:${sessionId}`;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  return `agent_${Math.abs(hash).toString(16).padStart(12, '0')}`;
}

/**
 * Generate a stable conversation ID from session
 */
export function generateConversationId(sessionId: string): string {
  // Conversation ID is typically the root session ID
  // For child sessions, we'd use the root session ID
  return `conv_${sessionId}`;
}

/**
 * Generate a unique span ID
 */
export function generateSpanId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Generate a unique trace ID
 */
export function generateTraceId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

// ─── Hash Functions ────────────────────────────────────────────────────────────

/**
 * Hash a memory key for PII-safe storage
 */
export function hashMemoryKey(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    const char = key.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return `mem_${Math.abs(hash).toString(16).padStart(8, '0')}`;
}

/**
 * Hash a string for comparison (e.g., context package diff)
 */
export function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
}

// ─── Context Window Utilities ──────────────────────────────────────────────────

/**
 * Estimate token count for a string (rough approximation)
 */
export function estimateTokens(text: string): number {
  // Rough approximation: ~4 characters per token for English
  return Math.ceil(text.length / 4);
}

/**
 * Create a context package snapshot from messages
 */
export function createContextPackage(
  messages: Array<{ role: string; content: string }>,
  maxTokens: number = 200000
): ContextPackage {
  let totalTokens = 0;
  const packagedMessages: Array<{ role: string; content: string; tokens: number }> = [];
  let truncated = false;

  // Process messages in reverse (most recent first) to fit in context window
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const tokens = estimateTokens(msg.content);
    
    if (totalTokens + tokens > maxTokens && packagedMessages.length > 0) {
      truncated = true;
      break;
    }
    
    packagedMessages.unshift({
      role: msg.role,
      content: msg.content,
      tokens,
    });
    totalTokens += tokens;
  }

  return {
    tokensSent: totalTokens,
    tokensReceived: totalTokens, // Will be updated by receiver
    truncated,
    messages: packagedMessages,
  };
}

/**
 * Calculate context window fill percentage
 */
export function calculateContextFill(
  usedTokens: number,
  maxTokens: number
): { fillPercent: number; tokensAvailable: number; tokensUsed: number } {
  const fillPercent = maxTokens > 0 ? (usedTokens / maxTokens) * 100 : 0;
  return {
    fillPercent: Math.min(100, Math.max(0, fillPercent)),
    tokensAvailable: Math.max(0, maxTokens - usedTokens),
    tokensUsed: usedTokens,
  };
}

/**
 * Diff two context packages
 */
export function diffContextPackages(
  sent: ContextPackage,
  received: ContextPackage
): string {
  const sentHashes = new Set(sent.messages.map(m => hashString(`${m.role}:${m.content}`)));
  const receivedHashes = new Set(received.messages.map(m => hashString(`${m.role}:${m.content}`)));
  
  const onlyInSent = sent.messages.filter(m => !receivedHashes.has(hashString(`${m.role}:${m.content}`)));
  const onlyInReceived = received.messages.filter(m => !sentHashes.has(hashString(`${m.role}:${m.content}`)));
  
  return JSON.stringify({
    sentOnly: onlyInSent.length,
    receivedOnly: onlyInReceived.length,
    sentTokens: sent.tokensSent,
    receivedTokens: received.tokensReceived,
    truncated: sent.truncated || received.truncated,
  });
}

// ─── Agent Info Helpers ────────────────────────────────────────────────────────

/**
 * Extract agent info from opencode session/message
 */
export function extractAgentInfo(
  agentName: string,
  sessionId: string,
  model?: string,
  provider?: string,
  description?: string,
  tools: string[] = []
): AgentInfo {
  return {
    id: generateAgentId(agentName, sessionId),
    name: agentName,
    description,
    model,
    provider,
    version: model ? `v1-${hashString(model).slice(0, 8)}` : undefined,
    tools,
    parentId: undefined,
    contextTokens: 0,
  };
}

/**
 * Get or create conversation context
 */
const conversationContexts = new Map<string, ConversationContext>();

export function getOrCreateConversationContext(
  conversationId: string,
  sessionId: string,
  rootAgentId: string,
  rootAgentName: string
): ConversationContext {
  let ctx = conversationContexts.get(conversationId);
  if (!ctx) {
    ctx = {
      conversationId,
      sessionId,
      rootAgentId,
      rootAgentName,
      agents: new Map(),
      workflowPattern: undefined,
      delegationChain: [],
    };
    conversationContexts.set(conversationId, ctx);
  }
  return ctx;
}

export function getConversationContext(conversationId: string): ConversationContext | undefined {
  return conversationContexts.get(conversationId);
}

export function clearConversationContext(conversationId: string): void {
  conversationContexts.delete(conversationId);
}

// ─── Current Span Helpers ──────────────────────────────────────────────────────

/**
 * Get the current active span
 */
export function getCurrentSpan(): Span | undefined {
  return trace.getSpan(context.active());
}

/**
 * Set the current span for a context
 */
export function setCurrentSpan(span: Span): Context {
  return trace.setSpan(context.active(), span);
}

/**
 * Run a function with a specific span as current
 */
export function withSpan<T>(span: Span, fn: () => T): T {
  return context.with(trace.setSpan(context.active(), span), fn);
}

// ─── Export ───────────────────────────────────────────────────────────────────

export type { AgentInfo, ContextPackage, ConversationContext };