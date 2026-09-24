/**
 * opencode-otel-plugin - LLM Request Contexts
 *
 * Keyed map of in-flight LLM requests for correct chat.headers traceparent injection
 * (ambient context.active() is often empty during header hooks).
 */

import type { Span } from "@opentelemetry/api";
import { MAX_PENDING, setBoundedMap } from "../utils/bounded.js";

export interface LlmRequestContext {
  span: Span;
  provider?: string;
  model?: string;
  conversationId?: string;
  agentId?: string;
}

const llmRequestContexts = new Map<string, LlmRequestContext>();

/** Providers allowed to receive W3C traceparent/baggage injection (allowlist; empty = all). */
const DEFAULT_PROVIDER_ALLOWLIST: string[] = [
  "openai",
  "anthropic",
  "google",
  "groq",
  "mistral",
  "deepseek",
  "xai",
  "openrouter",
  "azure",
  "bedrock",
  "vertex",
  "litellm",
  "ollama",
];

let providerAllowlist = new Set(DEFAULT_PROVIDER_ALLOWLIST.map((p) => p.toLowerCase()));

export function setProviderAllowlist(providers?: string[]): void {
  if (providers && providers.length > 0) {
    providerAllowlist = new Set(providers.map((p) => p.toLowerCase()));
  } else {
    providerAllowlist = new Set(DEFAULT_PROVIDER_ALLOWLIST.map((p) => p.toLowerCase()));
  }
}

export function isProviderAllowed(providerId: string | undefined): boolean {
  if (!providerId) return true; // unknown provider → allow (best-effort tracing)
  return providerAllowlist.has(providerId.toLowerCase());
}

export function setLlmRequestContext(sessionId: string, ctx: LlmRequestContext): void {
  setBoundedMap(llmRequestContexts, sessionId, ctx, MAX_PENDING);
}

export function getLlmRequestContext(sessionId: string): LlmRequestContext | undefined {
  return llmRequestContexts.get(sessionId);
}

export function clearLlmRequestContext(sessionId: string): void {
  llmRequestContexts.delete(sessionId);
}

export function clearAllLlmRequestContexts(): void {
  llmRequestContexts.clear();
}

/** Build W3C traceparent from a span's context. */
export function buildTraceParent(span: Span): string {
  const sc = span.spanContext();
  const flags = (sc.traceFlags ?? 1).toString(16).padStart(2, "0");
  return `00-${sc.traceId}-${sc.spanId}-${flags}`;
}
