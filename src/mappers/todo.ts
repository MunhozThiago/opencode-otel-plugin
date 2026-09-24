/**
 * opencode-otel-plugin - Todo Event Mapper
 * 
 * Maps opencode todo events to OpenTelemetry span events.
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
  validateOptionalRecord,
  validateOptionalInteger,
  validateOneOf,
  safeStringify,
  addSpanEvent,
  endSpan,
  setSpanAttribute,
} from "./validation.js";

export interface TodoEvent {
  type: 'todo.updated';
  properties: {
    info: {
      id: string;
      sessionID: string;
      content: string;
      status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
      priority?: 'high' | 'medium' | 'low';
      metadata?: Record<string, unknown>;
      createdAt?: number;
      updatedAt?: number;
    };
  };
}

/**
 * Creates or updates a todo span event on the session root span
 */
export function mapTodoUpdated(
  event: TodoEvent,
  tracer: ReturnType<typeof trace.getTracer>,
  activeSpans: Map<string, Span>
): Span | null {
  // ─── Step 1: Validate event structure ───────────────────────────────────────
  const shapeValidation = validateEventShape(event, "todo.updated");
  if (!shapeValidation.valid) {
    if (typeof tracer !== "undefined" && typeof tracer.startSpan === "function") {
      // Log validation errors without crashing
      try {
        console.warn("[otel] Todo mapper validation failed:", shapeValidation.errors);
      } catch {
        // Ignore logging errors
      }
    }
    return null;
  }

  const todo = event.properties?.info;
  if (!todo) return null;

  // ─── Step 2: Validate todo fields ───────────────────────────────────────────
  const errors: string[] = [];
  const id = validateId(todo.id, "todo.id", errors);
  const sessionId = validateSessionId(todo.sessionID);
  const content = validateOptionalString(todo.content, "todo.content", errors);
  const status = validateOneOf(
    todo.status,
    ["pending", "in_progress", "completed", "cancelled"],
    "todo.status",
    errors
  );
  const priority = validateOneOf(
    todo.priority,
    ["high", "medium", "low"],
    "todo.priority",
    errors
  );
  const metadata = validateOptionalRecord(todo.metadata, "todo.metadata", errors);
  const createdAt = validateOptionalInteger(todo.createdAt, "todo.createdAt", errors);
  const updatedAt = validateOptionalInteger(todo.updatedAt, "todo.updatedAt", errors);

  if (errors.length > 0) {
    try {
      console.warn("[otel] Todo mapper validation failed:", errors);
    } catch {
      // Ignore logging errors
    }
    return null;
  }

  // ─── Step 3: Create span with try/catch error boundary ─────────────────────
  try {
    const conversationId = generateConversationId(sessionId.value!);
    const rootSpan = activeSpans.get(`${conversationId}:root`);
    if (!rootSpan) return null;

    const todoAttrs: Attributes = {
      'todo.id': id.value!,
      'todo.content': content!,
      'todo.status': status!,
      'todo.session_id': sessionId.value!,
    };

    if (priority) todoAttrs['todo.priority'] = priority;
    if (metadata) todoAttrs['todo.metadata'] = safeStringify(metadata);
    if (createdAt !== undefined) todoAttrs['todo.created_at'] = createdAt;
    if (updatedAt !== undefined) todoAttrs['todo.updated_at'] = updatedAt;

    // Add todo event to the root span
    addSpanEvent(rootSpan, 'todo.updated', todoAttrs);

    if (rootSpan.spanContext().traceFlags & 1) { // is sampled
      // Also create a dedicated todo span for detailed tracking
      const agentId = generateAgentId('primary', sessionId.value!);
      const baseAttrs = createBaseAttributes(sessionId.value!, agentId, 'primary', conversationId, 'todo', {
        agentDescription: 'Todo tracker',
        sessionId: sessionId.value!,
      });
      
      // Merge todo attrs into base attrs
      const mergedAttrs = { ...baseAttrs };
      for (const [key, value] of Object.entries(todoAttrs)) {
        (mergedAttrs as Record<string, unknown>)[key] = value;
      }
      
      const todoSpan = tracer.startSpan(`todo.${id.value}`, {
        kind: SpanKind.INTERNAL,
        attributes: flattenAttributes(mergedAttrs),
      });
      
      setSpanAttribute(todoSpan, 'todo.id', id.value);
      setSpanAttribute(todoSpan, 'todo.content', content);
      setSpanAttribute(todoSpan, 'todo.status', status);
      if (priority) setSpanAttribute(todoSpan, 'todo.priority', priority);
      
      // End immediately since todos are typically short-lived
      endSpan(todoSpan);
      
      return todoSpan;
    }

    return rootSpan;
  } catch (error) {
    try {
      console.warn("[otel] Todo mapper failed:", error);
    } catch {
      // Ignore logging errors
    }
    return null;
  }
}