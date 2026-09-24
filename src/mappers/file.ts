/**
 * opencode-otel-plugin - File Event Mapper
 * 
 * Maps opencode file events to OpenTelemetry spans.
 */

import { trace, SpanKind } from "@opentelemetry/api";
import type { Span, Attributes } from "@opentelemetry/api";
import type { GenAIAttributes } from "../types.js";
import { createBaseAttributes, flattenAttributes } from "../otel/semantic-conventions.js";
import { generateConversationId, generateAgentId } from "../utils/ids.js";
import { enrichSpanAttributes } from "../otel/provider.js";
import {
  validateEventShape,
  validateSessionId,
  validateId,
  validateOptionalString,
  validateOptionalNumber,
  validateOptionalRecord,
  validateOneOf,
  safeStringify,
  truncateString,
  addSpanEvent,
  endSpan,
  setSpanAttribute,
} from "./validation.js";

export interface FileEvent {
  type: 'file.edited';
  properties: {
    info: {
      id: string;
      sessionID: string;
      path: string;
      operation: 'create' | 'read' | 'write' | 'delete' | 'edit';
      size?: number;
      linesAdded?: number;
      linesRemoved?: number;
      content?: string; // For small files, or diff
      hash?: string;
      startTime?: number;
      endTime?: number;
    };
  };
}

/**
 * Creates a file operation span
 */
export function mapFileEdited(
  event: FileEvent,
  tracer: ReturnType<typeof trace.getTracer>,
  piiRedactor: any,
  activeSpans: Map<string, Span>
): Span | null {
  // ─── Step 1: Validate event structure ───────────────────────────
  const shapeValidation = validateEventShape(event, "file.edited");
  if (!shapeValidation.valid) {
    try {
      console.warn("[otel] File mapper validation failed:", shapeValidation.errors);
    } catch {
      // Ignore logging errors
    }
    return null;
  }

  const file = event.properties?.info;
  if (!file) return null;

  // ─── Step 2: Validate file fields ───────────────────────────────
  const errors: string[] = [];
  const sessionId = validateSessionId(file.sessionID);
  const path = validateOptionalString(file.path, "file.path", errors);
  const operation = validateOneOf(
    file.operation,
    ["create", "read", "write", "delete", "edit"],
    "file.operation",
    errors
  );
  const size = validateOptionalNumber(file.size, "file.size", errors);
  const linesAdded = validateOptionalNumber(file.linesAdded, "file.linesAdded", errors);
  const linesRemoved = validateOptionalNumber(file.linesRemoved, "file.linesRemoved", errors);
  const hash = validateOptionalString(file.hash, "file.hash", errors);
  const startTime = validateOptionalNumber(file.startTime, "file.startTime", errors);
  const endTime = validateOptionalNumber(file.endTime, "file.endTime", errors);
  const content = validateOptionalString(file.content, "file.content", errors);

  if (errors.length > 0) {
    try {
      console.warn("[otel] File mapper validation failed:", errors);
    } catch {
      // Ignore logging errors
    }
    return null;
  }

  // ─── Step 3: Create span with error boundary ─────────────────────
  try {
    const conversationId = generateConversationId(sessionId.value!);
    const agentId = generateAgentId('primary', sessionId.value!);

    const spanName = `file.${operation}`;
    const baseAttrs = createBaseAttributes(sessionId.value!, agentId, 'primary', conversationId, 'file', {
      agentDescription: 'File operator',
      sessionId: sessionId.value!,
    });
    
    const fileAttrs: Attributes = {
      'file.path': path!,
      'file.operation': operation!,
      'file.session_id': sessionId.value!,
    };

    if (size !== undefined) fileAttrs['file.size_bytes'] = size;
    if (linesAdded !== undefined) fileAttrs['file.lines_added'] = linesAdded;
    if (linesRemoved !== undefined) fileAttrs['file.lines_removed'] = linesRemoved;
    if (hash) fileAttrs['file.hash'] = hash;
    if (startTime !== undefined) fileAttrs['file.start_time'] = startTime;
    if (endTime !== undefined) fileAttrs['file.end_time'] = endTime;

    // Don't include content in attributes (could be large/sensitive)
    // But add a flag if content was captured
    if (content) {
      fileAttrs['file.content_captured'] = true;
      fileAttrs['file.content_length'] = content.length;
      // Optionally include small content (first 500 chars)
      if (content.length <= 500) {
        fileAttrs['file.content_preview'] = content;
      }
    }

    // Merge file attrs into base attrs
    const mergedAttrs = { ...baseAttrs };
    for (const [key, value] of Object.entries(fileAttrs)) {
      (mergedAttrs as Record<string, unknown>)[key] = value;
    }

    const span = tracer.startSpan(spanName, {
      kind: SpanKind.INTERNAL,
      attributes: flattenAttributes(mergedAttrs),
    });

    enrichSpanAttributes(span, mergedAttrs as GenAIAttributes, piiRedactor);

    // Add as event to root span
    const rootSpan = activeSpans.get(`${conversationId}:root`);
    addSpanEvent(rootSpan, 'file.edited', fileAttrs);

    endSpan(span);
    return span;
  } catch (error) {
    try {
      console.warn("[otel] File mapper failed:", error);
    } catch {
      // Ignore logging errors
    }
    return null;
  }
}