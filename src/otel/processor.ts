/**
 * opencode-otel-plugin - Custom Span Processor
 * 
 * Span processors for PII redaction, enrichment, and export.
 */

import type { Span, SpanContext, Attributes } from "@opentelemetry/api";
import type { SpanProcessor, ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type { PIIRedactor } from "../utils/pii.js";
import { sessionAttributes } from "../utils/session-registry.js";

// ─── Enrichment Span Processor ────────────────────────────────────────────────

export class EnrichmentSpanProcessor implements SpanProcessor {
  private readonly piiRedactor: PIIRedactor;
  private readonly debug: boolean;
  private readonly defaultSpanAttributes: Attributes;

  constructor(
    piiRedactor: PIIRedactor,
    debug: boolean = false,
    defaultSpanAttributes?: Attributes
  ) {
    this.piiRedactor = piiRedactor;
    this.debug = debug;
    this.defaultSpanAttributes = defaultSpanAttributes ?? {};
  }

  onStart(span: Span, parentContext: SpanContext): void {
    // Apply configured spanAttributes to every span at start (P2: spanAttributes wiring)
    for (const [key, value] of Object.entries(this.defaultSpanAttributes)) {
      if (value !== undefined && value !== null) {
        try {
          (span as any).setAttribute?.(key, value as any);
        } catch {
          /* ignore */
        }
      }
    }
    this.applySessionAttributes(span);
  }

  /** Attach canonical session.id / session.name (registry-backed) to the span. */
  private applySessionAttributes(span: Span): void {
    try {
      const attrs = (span as any).attributes ?? {};
      const sid =
        typeof attrs["session.id"] === "string"
          ? attrs["session.id"]
          : typeof attrs["gen_ai.session.id"] === "string"
            ? attrs["gen_ai.session.id"]
            : undefined;
      const conversationId =
        typeof attrs["gen_ai.conversation.id"] === "string"
          ? attrs["gen_ai.conversation.id"]
          : undefined;
      for (const [key, value] of Object.entries(sessionAttributes(sid, conversationId))) {
        if (attrs[key] === undefined) {
          (span as any).setAttribute?.(key, value);
        }
      }
    } catch {
      /* ignore */
    }
  }

  onEnd(span: ReadableSpan): void {
    // Fallback for spans that gained a session id only after start
    try {
      const attrs = (span as any).attributes;
      if (attrs && attrs["session.id"] === undefined) {
        const sid =
          typeof attrs["gen_ai.session.id"] === "string" ? attrs["gen_ai.session.id"] : undefined;
        const conversationId =
          typeof attrs["gen_ai.conversation.id"] === "string"
            ? attrs["gen_ai.conversation.id"]
            : undefined;
        for (const [key, value] of Object.entries(sessionAttributes(sid, conversationId))) {
          if (attrs[key] === undefined) attrs[key] = value;
        }
      }
    } catch {
      /* ignore */
    }
    if (this.debug) {
      console.log(`[otel] Span ended: ${span.name}`, {
        traceId: span.spanContext().traceId,
        spanId: span.spanContext().spanId,
        attributes: span.attributes,
      });
    }
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

// ─── PII Redaction Processor ──────────────────────────────────────────────────

export class PIIRedactionProcessor implements SpanProcessor {
  private readonly piiRedactor: PIIRedactor;

  constructor(piiRedactor: PIIRedactor) {
    this.piiRedactor = piiRedactor;
  }

  onStart(span: Span, parentContext: SpanContext): void {
    // Redact attributes on start if needed
  }

  onEnd(span: ReadableSpan): void {
    // Attributes are redacted via enrichSpanAttributes before setting
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

// ─── Attribute Enrichment Helper ──────────────────────────────────────────────

export function enrichSpanAttributes(
  span: Span,
  attributes: Attributes,
  piiRedactor: PIIRedactor
): void {
  // Apply PII redaction
  const redacted = piiRedactor.redactAttributes(attributes);
  
  // Set attributes on span
  for (const [key, value] of Object.entries(redacted)) {
    if (value !== undefined && value !== null) {
      span.setAttribute(key, value);
    }
  }
}
