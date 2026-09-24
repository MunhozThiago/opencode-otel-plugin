/**
 * opencode-otel-plugin - Tool Event Mapper
 * 
 * Maps opencode tool execution hooks to OpenTelemetry spans.
 */

import { trace, SpanKind } from "@opentelemetry/api";
import type { Span } from "@opentelemetry/api";
import type { ToolEvent } from "../types.js";
import type { GenAIAttributes, ConversationContext } from "../types.js";
import { createBaseAttributes, addToolAttributes, flattenAttributes, addOpenInferenceAttributes } from "../otel/semantic-conventions.js";
import { getConversationContext, generateConversationId } from "../utils/ids.js";
import { enrichSpanAttributes } from "../otel/provider.js";

// ─── Tool Execute Before ──────────────────────────────────────────────────────

export function mapToolExecuteBefore(
  event: ToolEvent,
  tracer: ReturnType<typeof trace.getTracer>,
  piiRedactor: any,
  activeSpans: Map<string, Span>
): Span | null {
  const { tool, sessionID, callID } = (event as any).input || {};
  if (!tool || !sessionID || !callID) return null;

  const conversationId = generateConversationId(sessionID);
  const convCtx = getConversationContext(conversationId);
  if (!convCtx) return null;

  const agentId = convCtx.rootAgentId;
  const agentName = convCtx.rootAgentName;

  const isMCP = tool.startsWith('mcp__') || tool.startsWith('mcp.');
  const spanType = isMCP ? 'mcp.tool' : 'tool';

  const spanName = `tool.${tool}`;
  const span = tracer.startSpan(spanName, {
    kind: SpanKind.CLIENT,
    attributes: flattenAttributes(createBaseAttributes(sessionID, agentId, agentName, conversationId, spanType as any)),
  });

  // Add tool attributes
  // Note: input args would come from the hook output or message part
  const toolAttrs = addToolAttributes(
    {} as GenAIAttributes,
    {
      toolName: tool,
      toolCallId: callID,
      isMCP,
    }
  );
  addOpenInferenceAttributes(toolAttrs, { operationName: 'execute_tool', toolName: tool, toolCallId: callID });
  enrichSpanAttributes(span, toolAttrs, piiRedactor);

  // Store for after hook
  activeSpans.set(`${conversationId}:tool:${callID}`, span);

  return span;
}

// ─── Tool Execute After ───────────────────────────────────────────────────────

export function mapToolExecuteAfter(
  event: ToolEvent,
  tracer: ReturnType<typeof trace.getTracer>,
  piiRedactor: any,
  activeSpans: Map<string, Span>
): Span | null {
  const { tool, sessionID, callID, args, title, output, metadata } = (event as any).input || {};
  if (!tool || !sessionID || !callID) return null;

  const conversationId = generateConversationId(sessionID);
  const span = activeSpans.get(`${conversationId}:tool:${callID}`);
  if (!span) return null;

  const convCtx = getConversationContext(conversationId);
  const isMCP = tool.startsWith('mcp__') || tool.startsWith('mcp.');

  // Add completion attributes
  const toolAttrs = addToolAttributes(
    {} as GenAIAttributes,
    {
      toolName: tool,
      toolCallId: callID,
      input: args,
      output: output,
      durationMs: metadata?.durationMs,
      isMCP,
      mcpServerName: metadata?.server,
      mcpSessionId: metadata?.sessionId,
    }
  );
  enrichSpanAttributes(span, toolAttrs, piiRedactor);

  // Add title if available
  if (title) {
    span.setAttribute('tool.title', title);
  }

  span.end();
  activeSpans.delete(`${conversationId}:tool:${callID}`);

  return span;
}

// ─── Permission Hooks ─────────────────────────────────────────────────────────

export function mapPermissionAsk(
  event: any,
  tracer: ReturnType<typeof trace.getTracer>,
  piiRedactor: any,
  activeSpans: Map<string, Span>
): Span | null {
  const permission = (event as any).input;
  if (!permission) return null;

  const { sessionID, callID, title, metadata } = permission;
  if (!sessionID || !callID) return null;

  const conversationId = generateConversationId(sessionID);
  const convCtx = getConversationContext(conversationId);
  if (!convCtx) return null;

  const agentId = convCtx.rootAgentId;
  const agentName = convCtx.rootAgentName;

  // Create a span for the permission check
  const spanName = `permission.${title || 'unknown'}`;
  const span = tracer.startSpan(spanName, {
    kind: SpanKind.INTERNAL,
    attributes: flattenAttributes(createBaseAttributes(sessionID, agentId, agentName, conversationId, 'tool')),
  });

  span.setAttribute('permission.id', permission.id);
  span.setAttribute('permission.type', permission.type);
  span.setAttribute('permission.title', title);
  span.setAttribute('permission.pattern', permission.pattern || '');
  span.setAttribute('tool.blocked', true);
  span.setAttribute('tool.block_reason', 'permission_required');

  enrichSpanAttributes(span, {} as GenAIAttributes, piiRedactor);
  span.end();

  return span;
}

export function mapPermissionReplied(
  event: any,
  tracer: ReturnType<typeof trace.getTracer>,
  piiRedactor: any,
  activeSpans: Map<string, Span>
): Span | null {
  const { sessionID, permissionID, response } = (event as any).input || {};
  if (!sessionID || !permissionID) return null;

  const conversationId = generateConversationId(sessionID);
  const convCtx = getConversationContext(conversationId);
  if (!convCtx) return null;

  // This is typically handled by the tool.execute.after when the tool runs
  // But we can add an event to the tool span if it exists
  const toolSpanKey = Array.from(activeSpans.keys()).find(k => 
    k.startsWith(conversationId) && k.includes(':tool:')
  );
  
  if (toolSpanKey) {
    const span = activeSpans.get(toolSpanKey);
    if (span) {
      span.addEvent('permission.replied', {
        permission_id: permissionID,
        response: response,
      });
    }
  }

  return null;
}

// ─── Export ───────────────────────────────────────────────────────────────────

export const toolMapper = {
  executeBefore: mapToolExecuteBefore,
  executeAfter: mapToolExecuteAfter,
  permissionAsk: mapPermissionAsk,
  permissionReplied: mapPermissionReplied,
};