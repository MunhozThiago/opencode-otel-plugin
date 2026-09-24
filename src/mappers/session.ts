/**
 * opencode-otel-plugin - Session Event Mapper
 * 
 * Maps opencode session lifecycle events to OpenTelemetry spans.
 */

import { trace, SpanKind } from "@opentelemetry/api";
import type { Span, Context } from "@opentelemetry/api";
import type { SessionEvent } from "../types.js";
import type { GenAIAttributes, SpanMetadata, AgentInfo, ConversationContext } from "../types.js";
import type { RequiredConfig } from "../config.js";
import { createBaseAttributes, addSessionAttributes, flattenAttributes, spanTypeToSpanKind, spanTypeToOperationName } from "../otel/semantic-conventions.js";
import { getOrCreateConversationContext, clearConversationContext, generateConversationId, generateAgentId, extractAgentInfo } from "../utils/ids.js";
import { enrichSpanAttributes } from "../otel/provider.js";

// ─── Session Created ──────────────────────────────────────────────────────────

export function mapSessionCreated(
  event: SessionEvent,
  tracer: ReturnType<typeof trace.getTracer>,
  piiRedactor: any,
  config: RequiredConfig
): Span | null {
  const session = (event as any).properties?.info;
  if (!session) return null;

  const sessionId = session.id;
  const conversationId = generateConversationId(sessionId);
  const agentName = session.agent || "primary";
  const agentId = generateAgentId(agentName, sessionId);

  // Create conversation context
  const convCtx = getOrCreateConversationContext(conversationId, sessionId, agentId, agentName);
  convCtx.workflowPattern = "sequential"; // Default, updated later if needed

  // Create root agent info
  const agentInfo = extractAgentInfo(agentName, sessionId, session.model, undefined, undefined, []);
  convCtx.agents.set(agentId, agentInfo);

  // Create root span for the agent session
  const spanName = `agent.session.${agentName}`;
  const span = tracer.startSpan(spanName, {
    kind: SpanKind.CLIENT,
    attributes: flattenAttributes(createBaseAttributes(sessionId, agentId, agentName, conversationId, 'agent.root', {
      agentDescription: agentInfo.description,
      sessionId,
      workflowPattern: convCtx.workflowPattern,
      projectId: session.projectID,
    })),
  });

  // Add session attributes
  const sessionAttrs = addSessionAttributes(
    {} as GenAIAttributes,
    {
      sessionId,
      title: session.title,
      projectId: session.projectID,
      directory: session.directory,
      parentSessionId: session.parentID,
    }
  );
  enrichSpanAttributes(span, sessionAttrs, piiRedactor);
  // project.id common attribute (P2)
  if (session.projectID) {
    span.setAttribute('project.id', session.projectID);
    span.setAttribute('session.project_id', session.projectID);
  }

  // Store span reference
  agentInfo.span = span;

  return span;
}

// ─── Session Updated ──────────────────────────────────────────────────────────

export function mapSessionUpdated(
  event: SessionEvent,
  activeSpans: Map<string, Span>
): void {
  const session = (event as any).properties?.info;
  if (!session) return;

  const sessionId = session.id;
  const conversationId = generateConversationId(sessionId);
  const convCtx = getOrCreateConversationContext(conversationId, sessionId, '', '');

  // Update workflow pattern if agent changed
  if (session.agent && convCtx.workflowPattern === "sequential") {
    convCtx.workflowPattern = "handoff";
  }

  // Update root span attributes if needed
  const rootSpan = activeSpans.get(`${conversationId}:root`);
  if (rootSpan) {
    rootSpan.setAttribute('session.title', session.title || '');
    rootSpan.setAttribute('session.updated_at', session.time.updated);
  }
}

// ─── Session Deleted / Ended ──────────────────────────────────────────────────

export function mapSessionEnded(
  event: SessionEvent,
  activeSpans: Map<string, Span>,
  endTime: number = Date.now()
): void {
  const session = (event as any).properties?.info;
  const sessionId = session?.id || (event as any).properties?.sessionID;
  if (!sessionId) return;

  const conversationId = generateConversationId(sessionId);
  
  // End all spans for this conversation
  for (const [key, span] of activeSpans.entries()) {
    if (key.startsWith(conversationId)) {
      span.setAttribute('session.end_time', endTime);
      span.setAttribute('session.duration_ms', endTime - (span as any).startTime || 0);
      span.end(endTime);
    }
  }

  // Clean up
  activeSpans.forEach((_, key) => {
    if (key.startsWith(conversationId)) {
      activeSpans.delete(key);
    }
  });
  clearConversationContext(conversationId);
}

// ─── Session Status ───────────────────────────────────────────────────────────

export function mapSessionStatus(
  event: SessionEvent,
  activeSpans: Map<string, Span>
): void {
  const { sessionID, status } = (event as any).properties || {};
  if (!sessionID) return;

  const conversationId = generateConversationId(sessionID);
  const convCtx = getOrCreateConversationContext(conversationId, sessionID, '', '');

  // Update status on root span
  const rootSpan = activeSpans.get(`${conversationId}:root`);
  if (rootSpan) {
    if (typeof status === 'object' && status.type) {
      rootSpan.setAttribute('session.status', status.type);
      if (status.type === 'retry') {
        rootSpan.setAttribute('session.retry_attempt', status.attempt);
        rootSpan.setAttribute('session.retry_message', status.message);
      }
    } else {
      rootSpan.setAttribute('session.status', String(status));
    }
  }
}

// ─── Session Compacted ────────────────────────────────────────────────────────

export function mapSessionCompacted(
  event: SessionEvent,
  tracer: ReturnType<typeof trace.getTracer>,
  piiRedactor: any,
  activeSpans: Map<string, Span>
): Span | null {
  const { sessionID } = (event as any).properties || {};
  if (!sessionID) return null;

  const conversationId = generateConversationId(sessionID);
  const convCtx = getOrCreateConversationContext(conversationId, sessionID, '', '');
  const rootAgentId = convCtx.rootAgentId;

  // Create memory span for compaction
  const spanName = `session.compacted`;
  const span = tracer.startSpan(spanName, {
    kind: SpanKind.INTERNAL,
    attributes: flattenAttributes(createBaseAttributes(sessionID, rootAgentId, convCtx.rootAgentName, conversationId, 'compaction')),
  });

  // Add compaction attributes
  span.setAttribute('session.compacted', true);
  span.setAttribute('agent.memory.operation', 'create');
  
  // Estimate tokens before/after (would need actual data from opencode)
  span.setAttribute('agent.context.window.tokens_before', 0); // Placeholder
  span.setAttribute('agent.context.window.tokens_after', 0);  // Placeholder

  enrichSpanAttributes(span, {} as GenAIAttributes, piiRedactor);
  span.end();

  return span;
}

// ─── Session Error ────────────────────────────────────────────────────────────

export function mapSessionError(
  event: SessionEvent,
  activeSpans: Map<string, Span>
): void {
  const { sessionID, error } = (event as any).properties || {};
  if (!sessionID) return;

  const conversationId = generateConversationId(sessionID);
  
  // Mark all spans as errored
  for (const [key, span] of activeSpans.entries()) {
    if (key.startsWith(conversationId)) {
      span.setAttribute('error', true);
      span.setAttribute('error.type', 'session.error');
      if (error) {
        span.setAttribute('error.message', error.message || String(error));
        span.setAttribute('error.stack', error.stack || '');
      }
      span.end();
    }
  }
}

// ─── Export ───────────────────────────────────────────────────────────────────

export const sessionMapper = {
  created: mapSessionCreated,
  updated: mapSessionUpdated,
  deleted: mapSessionEnded,
  status: mapSessionStatus,
  compacted: mapSessionCompacted,
  error: mapSessionError,
};