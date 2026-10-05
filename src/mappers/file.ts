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
  resolveEventPayload,
} from "./validation.js";

/**
 * Real opencode `file.edited` is `{ properties: { file: string } }` — flat,
 * no sessionID, no operation. Legacy/extended shapes may nest under `info`.
 */
export interface FileEvent {
  type: 'file.edited';
  properties: {
    file?: string;
    sessionID?: string;
    info?: {
      id?: string;
      sessionID?: string;
      path?: string;
      operation?: 'create' | 'read' | 'write' | 'delete' | 'edit';
      size?: number;
      linesAdded?: number;
      linesRemoved?: number;
      content?: string;
      hash?: string;
      startTime?: number;
      endTime?: number;
    };
    [key: string]: unknown;
  };
}

/**
 * Creates a file operation span.
 *
 * @param fallbackSessionId Last-seen session id — real `file.edited` events
 *   carry only a path, so we attribute them to the active session when known.
 */
export function mapFileEdited(
  event: FileEvent,
  tracer: ReturnType<typeof trace.getTracer>,
  piiRedactor: any,
  activeSpans: Map<string, Span>,
  fallbackSessionId?: string
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

  const file = resolveEventPayload(event);
  if (!file) return null;

  // ─── Step 2: Validate file fields ───────────────────────────────
  const errors: string[] = [];
  const sessionID =
    (typeof file.sessionID === "string" && file.sessionID) || fallbackSessionId;
  const sessionId = validateSessionId(sessionID);
  if (!sessionId.valid) {
    // Real file.edited events have no sessionID; without a fallback session
    // we cannot attribute the event — skip quietly (not a malformed event).
    return null;
  }
  // Flat shape exposes the path as `file`; nested shape uses `path`.
  const path = validateId(file.path ?? file.file, "file.path", errors);
  const operation =
    file.operation === undefined
      ? "edit"
      : validateOneOf(
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
      'file.path': path.value!,
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