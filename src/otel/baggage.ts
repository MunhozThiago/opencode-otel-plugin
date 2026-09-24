/**
 * opencode-otel-plugin - W3C Baggage Propagation
 * 
 * Handles W3C TraceContext and Baggage propagation for multi-agent correlation.
 * Based on: https://www.w3.org/TR/baggage/ and https://www.w3.org/TR/trace-context/
 */

import { context, propagation, trace, ROOT_CONTEXT } from "@opentelemetry/api";
import type { Context, TextMapPropagator, TextMapSetter, TextMapGetter, SpanContext } from "@opentelemetry/api";
import type { BaggageEntries, SpanContext as TypesSpanContext } from "../types.js";

// Type for propagation object
type PropagationAPI = {
  TextMapPropagator: new () => TextMapPropagator;
  TextMapSetter: {
    set(carrier: unknown, key: string, value: string): void;
  };
  TextMapGetter: {
    get(carrier: unknown, key: string): string | undefined;
  };
};

// ─── Baggage Keys ──────────────────────────────────────────────────────────────

export const BAGGAGE_KEYS = {
  CONVERSATION_ID: 'gen_ai.conversation.id',
  AGENT_ID: 'gen_ai.agent.id',
  SESSION_ID: 'gen_ai.session.id',
} as const;

// ─── Baggage Propagator ────────────────────────────────────────────────────────

/**
 * Creates a baggage propagator for GenAI correlation keys
 */
export function createBaggagePropagator(): TextMapPropagator {
  return {
    inject(context: Context, carrier: unknown, setter: TextMapSetter): void {
      const baggage = getBaggage(context);
      if (baggage && Object.keys(baggage).length > 0) {
        const headerValue = serializeBaggage(baggage);
        setter.set(carrier, 'baggage', headerValue);
      }
      
      // Also inject traceparent for trace continuity
      const spanContext = trace.getSpanContext(context);
      if (spanContext) {
        setter.set(carrier, 'traceparent', serializeTraceParent(spanContext));
      }
    },
    
    extract(context: Context, carrier: unknown, getter: TextMapGetter): Context {
      let newContext = context;
      
      // Extract baggage
      const baggageHeader = getter.get(carrier, 'baggage');
      if (baggageHeader) {
        const baggage = parseBaggage(baggageHeader);
        newContext = setBaggage(newContext, baggage);
      }
      
      // Extract traceparent
      const traceparentHeader = getter.get(carrier, 'traceparent');
      if (traceparentHeader) {
        const spanContext = parseTraceParent(traceparentHeader);
        if (spanContext) {
          newContext = trace.setSpan(newContext, { spanContext: () => spanContext } as any);
        }
      }
      
      return newContext;
    },
    
    fields(): string[] {
      return ['baggage', 'traceparent'];
    },
  };
}

// ─── Baggage Serialization ─────────────────────────────────────────────────────

export function serializeBaggage(baggage: Record<string, string>): string {
  return Object.entries(baggage)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join(', ');
}

export function parseBaggage(header: string): Record<string, string> {
  const result: Record<string, string> = {};
  
  for (const member of header.split(',')) {
    const [key, ...valueParts] = member.trim().split('=');
    if (key && valueParts.length > 0) {
      try {
        result[decodeURIComponent(key)] = decodeURIComponent(valueParts.join('='));
      } catch {
        // Ignore malformed entries
      }
    }
  }
  
  return result;
}

// ─── TraceParent Serialization ─────────────────────────────────────────────────

export function serializeTraceParent(spanContext: SpanContext): string {
  const version = '00';
  const traceId = spanContext.traceId;
  const spanId = spanContext.spanId;
  const traceFlags = spanContext.traceFlags?.toString(16).padStart(2, '0') || '01';
  
  return `${version}-${traceId}-${spanId}-${traceFlags}`;
}

export function parseTraceParent(header: string): TypesSpanContext | null {
  const parts = header.split('-');
  if (parts.length !== 4) return null;
  
  const [version, traceId, spanId, traceFlags] = parts;
  if (version !== '00') return null;
  if (traceId.length !== 32) return null;
  if (spanId.length !== 16) return null;
  
  const flags = parseInt(traceFlags, 16);
  if (isNaN(flags)) return null;
  
  return {
    traceId,
    spanId,
    traceFlags: flags,
  } as TypesSpanContext;
}

// ─── Context Helpers ───────────────────────────────────────────────────────────

/**
 * Get baggage from context
 */
export function getBaggage(ctx: Context): Record<string, string> | undefined {
  return context.getValue(ctx, 'baggage') as Record<string, string> | undefined;
}

/**
 * Set baggage in context
 */
export function setBaggage(ctx: Context, baggage: Record<string, string>): Context {
  return context.setValue(ctx, 'baggage', baggage);
}

/**
 * Create baggage entries for a conversation
 */
export function createConversationBaggage(
  conversationId: string,
  agentId?: string,
  sessionId?: string
): Record<string, string> {
  const baggage: Record<string, string> = {
    [BAGGAGE_KEYS.CONVERSATION_ID]: conversationId,
  };
  
  if (agentId) {
    baggage[BAGGAGE_KEYS.AGENT_ID] = agentId;
  }
  
  if (sessionId) {
    baggage[BAGGAGE_KEYS.SESSION_ID] = sessionId;
  }
  
  return baggage;
}

/**
 * Extract conversation ID from context (baggage or span attributes)
 */
export function getConversationId(ctx: Context): string | undefined {
  const baggage = getBaggage(ctx);
  if (baggage?.[BAGGAGE_KEYS.CONVERSATION_ID]) {
    return baggage[BAGGAGE_KEYS.CONVERSATION_ID];
  }
  
  // Fallback: check active span attributes
  const span = trace.getSpan(ctx);
  if (span) {
    const attrs = span.spanContext();
    // Note: span attributes not directly accessible from SpanContext
    // Would need span reference for this
  }
  
  return undefined;
}

/**
 * Inject baggage into outgoing HTTP headers
 */
export function injectBaggageHeaders(
  headers: Record<string, string>,
  conversationId: string,
  agentId?: string,
  sessionId?: string
): Record<string, string> {
  const baggage = createConversationBaggage(conversationId, agentId, sessionId);
  const result = { ...headers };
  
  result['baggage'] = serializeBaggage(baggage);
  
  // Get current trace context
  const span = trace.getSpan(context.active());
  if (span) {
    const spanContext = span.spanContext();
    result['traceparent'] = serializeTraceParent(spanContext);
  }
  
  return result;
}

/**
 * Extract baggage from incoming HTTP headers
 */
export function extractBaggageHeaders(headers: Record<string, string>): {
  conversationId?: string;
  agentId?: string;
  sessionId?: string;
  traceContext?: TypesSpanContext;
  traceparent?: string;
} {
  const result: {
    conversationId?: string;
    agentId?: string;
    sessionId?: string;
    traceContext?: TypesSpanContext;
    traceparent?: string;
  } = {};
  
  // Extract baggage
  const baggageHeader = headers['baggage'] || headers['Baggage'];
  if (baggageHeader) {
    const baggage = parseBaggage(baggageHeader);
    result.conversationId = baggage[BAGGAGE_KEYS.CONVERSATION_ID];
    result.agentId = baggage[BAGGAGE_KEYS.AGENT_ID];
    result.sessionId = baggage[BAGGAGE_KEYS.SESSION_ID];
  }
  
  // Extract traceparent
  const traceparentHeader = headers['traceparent'] || headers['Traceparent'];
  if (traceparentHeader) {
    result.traceparent = traceparentHeader;
    const parsed = parseTraceParent(traceparentHeader);
    if (parsed) {
      result.traceContext = parsed;
    }
  }
  
  return result;
}

// ─── Context Propagation for MCP/A2A ──────────────────────────────────────────

/**
 * Create a context with baggage for outbound MCP/A2A calls
 */
export function createOutboundContext(
  conversationId: string,
  agentId: string,
  sessionId?: string
): Context {
  const baggage = createConversationBaggage(conversationId, agentId, sessionId);
  let ctx = setBaggage(context.active(), baggage);
  
  // Add current trace context if available
  const currentSpan = trace.getSpan(context.active());
  if (currentSpan) {
    ctx = trace.setSpan(ctx, currentSpan);
  }
  
  return ctx;
}

/**
 * Run a function with baggage context
 */
export function runWithBaggage<T>(
  conversationId: string,
  agentId: string,
  sessionId: string | undefined,
  fn: () => T
): T {
  const ctx = createOutboundContext(conversationId, agentId, sessionId);
  return context.with(ctx, fn);
}

// ─── Export ───────────────────────────────────────────────────────────────────

export { propagation, trace, context };
export type { Context, SpanContext, BaggageEntries };