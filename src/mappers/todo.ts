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
  resolveEventPayload,
} from "./validation.js";

interface NormalizedTodo {
  id?: string;
  content?: string;
  status?: string;
  priority?: string;
  metadata?: Record<string, unknown>;
  createdAt?: number;
  updatedAt?: number;
}

/**
 * Real opencode `todo.updated` is `{ sessionID, todos: Todo[] }` — an array
 * at the properties level. Legacy shapes nest a single todo under `info`.
 */
export interface TodoEvent {
  type: 'todo.updated';
  properties: {
    sessionID?: string;
    todos?: Array<{
      id?: string;
      content?: string;
      status?: string;
      priority?: string;
      [key: string]: unknown;
    }>;
    info?: {
      id?: string;
      sessionID?: string;
      content?: string;
      status?: string;
      priority?: string;
      metadata?: Record<string, unknown>;
      createdAt?: number;
      updatedAt?: number;
    };
    [key: string]: unknown;
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

  const payload = resolveEventPayload(event);
  if (!payload) return null;

  const sessionId = validateSessionId(payload.sessionID);
  if (!sessionId.valid) {
    // Cannot attribute without a session — skip quietly
    return null;
  }

  // Real shape: `todos` array; legacy shape: payload IS the single todo.
  const rawTodos: unknown[] = Array.isArray(payload.todos)
    ? payload.todos
    : [payload];
  const listPrefix = rawTodos.length > 1 ? `todos[${rawTodos.length - 1}].` : "";

  // ─── Step 2: Validate todo fields ───────────────────────────────────────────
  const errors: string[] = [];
  const prepared: NormalizedTodo[] = [];
  for (const [index, candidate] of rawTodos.entries()) {
    const todo = (candidate ?? {}) as Record<string, unknown>;
    const prefix = rawTodos.length > 1 ? `todos[${index}].` : "";
    const id = validateId(todo.id, `${prefix}todo.id`, errors);
    const content = validateOptionalString(todo.content, `${prefix}todo.content`, errors);
    const status = validateOneOf(
      todo.status,
      ["pending", "in_progress", "completed", "cancelled"],
      `${prefix}todo.status`,
      errors
    );
    // priority is optional — only validate when present
    const priority =
      todo.priority === undefined
        ? undefined
        : validateOneOf(todo.priority, ["high", "medium", "low"], `${prefix}todo.priority`, errors);
    const metadata = validateOptionalRecord(todo.metadata, `${prefix}todo.metadata`, errors);
    const createdAt = validateOptionalInteger(todo.createdAt, `${prefix}todo.createdAt`, errors);
    const updatedAt = validateOptionalInteger(todo.updatedAt, `${prefix}todo.updatedAt`, errors);

    if (id.valid && status) {
      prepared.push({
        id: id.value,
        content,
        status,
        priority,
        metadata,
        createdAt,
        updatedAt,
      });
    }
  }

  if (errors.length > 0 || prepared.length === 0) {
    if (errors.length > 0) {
      try {
        console.warn("[otel] Todo mapper validation failed:", errors);
      } catch {
        // Ignore logging errors
      }
    }
    return null;
  }

  // ─── Step 3: Create span with try/catch error boundary ─────────────────────
  try {
    const conversationId = generateConversationId(sessionId.value!);
    const rootSpan = activeSpans.get(`${conversationId}:root`);
    if (!rootSpan) return null;

    let resultSpan: Span = rootSpan;
    for (const todo of prepared) {
      const todoAttrs: Attributes = {
        'todo.id': todo.id!,
        'todo.content': todo.content ?? '',
        'todo.status': todo.status!,
        'todo.session_id': sessionId.value!,
      };

      if (todo.priority) todoAttrs['todo.priority'] = todo.priority;
      if (todo.metadata) todoAttrs['todo.metadata'] = safeStringify(todo.metadata);
      if (todo.createdAt !== undefined) todoAttrs['todo.created_at'] = todo.createdAt;
      if (todo.updatedAt !== undefined) todoAttrs['todo.updated_at'] = todo.updatedAt;

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
        
        const todoSpan = tracer.startSpan(`todo.${todo.id}`, {
          kind: SpanKind.INTERNAL,
          attributes: flattenAttributes(mergedAttrs),
        });
        
        setSpanAttribute(todoSpan, 'todo.id', todo.id);
        setSpanAttribute(todoSpan, 'todo.content', todo.content);
        setSpanAttribute(todoSpan, 'todo.status', todo.status);
        if (todo.priority) setSpanAttribute(todoSpan, 'todo.priority', todo.priority);
        
        // End immediately since todos are typically short-lived
        endSpan(todoSpan);
        
        resultSpan = todoSpan;
      }
    }

    return resultSpan;
  } catch (error) {
    try {
      console.warn("[otel] Todo mapper failed:", error);
    } catch {
      // Ignore logging errors
    }
    return null;
  }
}