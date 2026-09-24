/**
 * opencode-otel-plugin - Remote Parent Trace Context
 *
 * Parses OPENCODE_TRACEPARENT / OPENCODE_TRACESTATE (or options) so
 * plugin spans nest under an external caller (CI job, gateway).
 */

import { ROOT_CONTEXT, trace } from "@opentelemetry/api";
import type { Context, SpanContext } from "@opentelemetry/api";
import { parseTraceParent } from "./baggage.js";

/**
 * Build a remote parent Context from W3C traceparent/tracestate strings.
 * Returns null when traceparent is missing or invalid.
 */
export function remoteParentContext(
  traceparent: string | undefined,
  _tracestate?: string
): Context | null {
  if (!traceparent) return null;
  const parsed = parseTraceParent(traceparent.trim());
  if (!parsed) return null;

  const spanContext: SpanContext = {
    traceId: parsed.traceId,
    spanId: parsed.spanId,
    traceFlags: parsed.traceFlags,
    isRemote: true,
  };

  // Non-sampled remote parent (flags & 1 === 0) is still valid as parent
  return trace.setSpan(ROOT_CONTEXT, { spanContext: () => spanContext } as any);
}

/** Returns ROOT_CONTEXT when no valid remote parent is configured. */
export function resolveRootContext(
  traceparent?: string,
  tracestate?: string
): Context {
  return remoteParentContext(traceparent, tracestate) ?? ROOT_CONTEXT;
}
