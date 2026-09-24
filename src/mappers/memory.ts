/**
 * opencode-otel-plugin - Memory Event Mapper
 * 
 * Maps memory operation events to OpenTelemetry spans.
 */

import { trace, SpanKind } from "@opentelemetry/api";
import type { Span, Attributes } from "@opentelemetry/api";
import type { GenAIAttributes } from "../types.js";
import { createBaseAttributes, addMemoryAttributes, flattenAttributes } from "../otel/semantic-conventions.js";
import { generateConversationId, generateAgentId } from "../utils/ids.js";
import { enrichSpanAttributes } from "../otel/provider.js";
import {
  validateEventShape,
  validateSessionId,
  validateId,
  validateOptionalString,
  validateOptionalNumber,
  validateOptionalBoolean,
  validateOptionalRecord,
  validateOneOf,
  safeStringify,
  truncateString,
  addSpanEvent,
  endSpan,
  setSpanAttribute,
} from "./validation.js";

export interface MemoryEvent {
  type: 'memory.create' | 'memory.search' | 'memory.update' | 'memory.delete';
  properties: {
    info: {
      id: string;
      sessionID: string;
      operation: 'create' | 'search' | 'update' | 'delete';
      key: string;
      keyHash?: string;
      value?: unknown;
      version?: number;
      hit?: boolean;
      size?: number;
      metadata?: Record<string, unknown>;
      durationMs?: number;
      startTime?: number;
      endTime?: number;
    };
  };
}

/**
 * Creates a memory operation span
 */
export function mapMemoryOperation(
  event: MemoryEvent,
  tracer: ReturnType<typeof trace.getTracer>,
  piiRedactor: any,
  activeSpans: Map<string, Span>
): Span | null {
  // ─── Step 1: Validate event structure ───────────────────────────
  const shapeValidation = validateEventShape(event, "memory.create|memory.search|memory.update|memory.delete");
  if (!shapeValidation.valid) {
    try {
      console.warn("[otel] Memory mapper validation failed:", shapeValidation.errors);
    } catch {
      // Ignore logging errors
    }
    return null;
  }

  const mem = event.properties?.info;
  if (!mem) return null;

  // ─── Step 2: Validate memory fields ─────────────────────────────
  const errors: string[] = [];
  const sessionId = validateSessionId(mem.sessionID);
  const operation = validateOneOf(
    mem.operation,
    ["create", "search", "update", "delete"],
    "memory.operation",
    errors
  );
  const key = validateId(mem.key, "memory.key", errors);
  const keyHash = validateOptionalString(mem.keyHash, "memory.keyHash", errors);
  const value = validateOptionalRecord(mem.value, "memory.value", errors);
  const version = validateOptionalNumber(mem.version, "memory.version", errors);
  const hit = validateOptionalBoolean(mem.hit, "memory.hit", errors);
  const size = validateOptionalNumber(mem.size, "memory.size", errors);
  const metadata = validateOptionalRecord(mem.metadata, "memory.metadata", errors);
  const durationMs = validateOptionalNumber(mem.durationMs, "memory.durationMs", errors);
  const startTime = validateOptionalNumber(mem.startTime, "memory.startTime", errors);
  const endTime = validateOptionalNumber(mem.endTime, "memory.endTime", errors);

  if (errors.length > 0) {
    try {
      console.warn("[otel] Memory mapper validation failed:", errors);
    } catch {
      // Ignore logging errors
    }
    return null;
  }

  // ─── Step 3: Create span with error boundary ───────────────────
  try {
    const conversationId = generateConversationId(sessionId.value!);
    const agentId = generateAgentId('primary', sessionId.value!);

    // Create memory operation span
    const spanName = `memory.${operation!}`;
    const baseAttrs = createBaseAttributes(sessionId.value!, agentId, 'primary', conversationId, `memory.${operation!}`, {
      agentDescription: 'Memory operator',
      sessionId: sessionId.value!,
    });
    
    // Use addMemoryAttributes
    const memOp = {
      operation: operation!,
      key: key!.value!,
      keyHash: keyHash ?? `hash_${key!.value!}`,
      version: version,
      hit,
      size,
    };
    const memAttrs = addMemoryAttributes(baseAttrs, memOp);

    if (metadata) memAttrs['memory.metadata'] = safeStringify(metadata);
    if (durationMs !== undefined) memAttrs['memory.duration_ms'] = durationMs;
    if (startTime !== undefined) memAttrs['memory.start_time'] = startTime;
    if (endTime !== undefined) memAttrs['memory.end_time'] = endTime;

    // Don't include full value in attributes (could be large/sensitive)
    if (value !== undefined) {
      memAttrs['memory.value_captured'] = true;
      const valueStr = safeStringify(value);
      memAttrs['memory.value_length'] = valueStr.length;
      // Optionally include small values (first 500 chars)
      if (valueStr.length <= 500) {
        memAttrs['memory.value_preview'] = valueStr;
      }
    }

    const span = tracer.startSpan(spanName, {
      kind: SpanKind.INTERNAL,
      attributes: flattenAttributes(memAttrs),
    });

    enrichSpanAttributes(span, memAttrs, piiRedactor);

    // Add as event to root span
    const rootSpan = activeSpans.get(`${conversationId}:root`);
    addSpanEvent(rootSpan, 'memory.operation', memAttrs);

    endSpan(span);
    return span;
  } catch (error) {
    try {
      console.warn("[otel] Memory mapper failed:", error);
    } catch {
      // Ignore logging errors
    }
    return null;
  }
}