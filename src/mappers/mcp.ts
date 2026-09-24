/**
 * opencode-otel-plugin - MCP Event Mapper
 * 
 * Maps MCP (Model Context Protocol) tool events to OpenTelemetry spans.
 */

import { trace, SpanKind } from "@opentelemetry/api";
import type { Span, Attributes } from "@opentelemetry/api";
import type { GenAIAttributes } from "../types.js";
import { createBaseAttributes, addToolAttributes, flattenAttributes } from "../otel/semantic-conventions.js";
import { generateConversationId, generateAgentId } from "../utils/ids.js";
import { enrichSpanAttributes } from "../otel/provider.js";
import {
  validateEventShape,
  validateSessionId,
  validateId,
  validateOptionalRecord,
  validateOptionalNumber,
  validateOptionalBoolean,
  validateOneOf,
  safeStringify,
  truncateString,
  addSpanEvent,
  endSpan,
  setSpanAttribute,
  setActiveSpan,
  deleteActiveSpan,
} from "./validation.js";

export interface MCPToolEvent {
  type: 'mcp.tool.call' | 'mcp.tool.result' | 'mcp.tool.error';
  properties: {
    info: {
      id: string;
      sessionID: string;
      serverName: string;
      methodName: string;
      callID: string;
      params?: Record<string, unknown>;
      result?: unknown;
      error?: {
        code: number;
        message: string;
        data?: unknown;
      };
      durationMs?: number;
      startTime?: number;
      endTime?: number;
    };
  };
}

/**
 * Creates an MCP tool call span
 */
export function mapMCPToolCall(
  event: MCPToolEvent,
  tracer: ReturnType<typeof trace.getTracer>,
  piiRedactor: any,
  activeSpans: Map<string, Span>
): Span | null {
  // ─── Step 1: Validate event structure ───────────────────────────
  const shapeValidation = validateEventShape(event, "mcp.tool.call");
  if (!shapeValidation.valid) {
    try {
      console.warn("[otel] MCP call mapper validation failed:", shapeValidation.errors);
    } catch {
      // Ignore logging errors
    }
    return null;
  }

  const tool = event.properties?.info;
  if (!tool) return null;

  // ─── Step 2: Validate MCP tool fields ─────────────────────────────
  const errors: string[] = [];
  const sessionId = validateSessionId(tool.sessionID);
  const serverName = validateId(tool.serverName, "mcp.server.name", errors);
  const methodName = validateId(tool.methodName, "mcp.method.name", errors);
  const callId = validateId(tool.callID, "mcp.call.id", errors);
  const params = validateOptionalRecord(tool.params, "mcp.params", errors);
  const result = validateOptionalRecord(tool.result, "mcp.result", errors);
  const error = validateOptionalRecord(tool.error, "mcp.error", errors);
  const durationMs = validateOptionalNumber(tool.durationMs, "mcp.durationMs", errors);
  const startTime = validateOptionalNumber(tool.startTime, "mcp.startTime", errors);
  const endTime = validateOptionalNumber(tool.endTime, "mcp.endTime", errors);

  if (errors.length > 0) {
    try {
      console.warn("[otel] MCP call mapper validation failed:", errors);
    } catch {
      // Ignore logging errors
    }
    return null;
  }

  // ─── Step 3: Create span with error boundary ─────────────────────
  try {
    const conversationId = generateConversationId(sessionId.value!);
    const agentId = generateAgentId('primary', sessionId.value!);

    // Create MCP tool span
    const spanName = `mcp.tool.${methodName!.value}`;
    const baseAttrs = createBaseAttributes(sessionId.value!, agentId, 'primary', conversationId, 'mcp.tool', {
      agentDescription: 'MCP tool client',
      sessionId: sessionId.value!,
    });
    
    // Use addToolAttributes with MCP options
    const mcpAttrs = addToolAttributes(baseAttrs, {
      toolName: methodName!.value!,
      toolCallId: callId!.value!,
      input: params,
      isMCP: true,
      mcpServerName: serverName!.value!,
    });

    if (durationMs !== undefined) mcpAttrs['mcp.duration_ms'] = durationMs;
    if (startTime !== undefined) mcpAttrs['mcp.start_time'] = startTime;
    if (endTime !== undefined) mcpAttrs['mcp.end_time'] = endTime;

    const span = tracer.startSpan(spanName, {
      kind: SpanKind.CLIENT,
      attributes: flattenAttributes(mcpAttrs),
    });

    enrichSpanAttributes(span, mcpAttrs, piiRedactor);

    // Store span for result/error correlation
    setActiveSpan(activeSpans, `${conversationId}:mcp:${callId!.value}`, span);

    return span;
  } catch (error) {
    try {
      console.warn("[otel] MCP call mapper failed:", error);
    } catch {
      // Ignore logging errors
    }
    return null;
  }
}

/**
 * Updates MCP tool span with result
 */
export function mapMCPToolResult(
  event: MCPToolEvent,
  activeSpans: Map<string, Span>
): void {
  const tool = event.properties?.info;
  if (!tool) return;

  const sessionId = tool.sessionID;
  const conversationId = generateConversationId(sessionId);
  const callId = tool.callID;

  const span = activeSpans.get(`${conversationId}:mcp:${callId}`);
  if (!span) return;

  if (tool.result !== undefined) {
    // Truncate result to avoid huge spans
    const resultStr = safeStringify(tool.result);
    if (resultStr.length > 10000) {
      setSpanAttribute(span, 'mcp.result', resultStr.substring(0, 10000) + '...[truncated]');
    } else {
      setSpanAttribute(span, 'mcp.result', resultStr);
    }
  }

  if (tool.durationMs !== undefined) {
    setSpanAttribute(span, 'mcp.duration_ms', tool.durationMs);
  }

  setSpanAttribute(span, 'mcp.success', true);
  endSpan(span);
  deleteActiveSpan(activeSpans, `${conversationId}:mcp:${callId}`);
}

/**
 * Updates MCP tool span with error
 */
export function mapMCPToolError(
  event: MCPToolEvent,
  activeSpans: Map<string, Span>
): void {
  const tool = event.properties?.info;
  if (!tool) return;

  const sessionId = tool.sessionID;
  const conversationId = generateConversationId(sessionId);
  const callId = tool.callID;

  const span = activeSpans.get(`${conversationId}:mcp:${callId}`);
  if (!span) return;

  if (tool.error) {
    setSpanAttribute(span, 'mcp.error_code', tool.error.code);
    setSpanAttribute(span, 'mcp.error_message', tool.error.message);
    if (tool.error.data) {
      const errorDataStr = safeStringify(tool.error.data);
      setSpanAttribute(span, 'mcp.error_data', errorDataStr.length > 10000 
        ? errorDataStr.substring(0, 10000) + '...[truncated]' 
        : errorDataStr);
    }
  }

  setSpanAttribute(span, 'mcp.success', false);
  setSpanAttribute(span, 'error', true);
  endSpan(span);
  deleteActiveSpan(activeSpans, `${conversationId}:mcp:${callId}`);
}