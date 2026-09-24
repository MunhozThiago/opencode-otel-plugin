/**
 * opencode-otel-plugin - Conversation-Aware Sampler
 * 
 * Implements sampling that never samples mid-conversation.
 * All spans in a conversation are either all sampled or all dropped.
 */

import { trace, SpanKind, ROOT_CONTEXT } from "@opentelemetry/api";
import * as api from "@opentelemetry/api";
import type { ConversationSampler } from "../types.js";
import { getBaggage } from "./baggage.js";

// ─── Conversation-Aware Sampler ────────────────────────────────────────────────

export class ConversationAwareSampler implements ConversationSampler {
  private readonly rate: number;
  private readonly parentBased: boolean;
  private readonly conversationCache = new Map<string, api.SamplingResult>();
  private readonly maxCacheSize = 10000;
  private readonly parentSampler: api.Sampler;

  constructor(rate: number = 1.0, parentBased: boolean = true) {
    this.rate = Math.max(0, Math.min(1, rate));
    this.parentBased = parentBased;
    // Use a simple parent-based sampler as fallback since we can't access global tracer provider
    this.parentSampler = new ParentBasedSampler(rate);
  }

  shouldSample(
    ctx: api.Context,
    traceId: string,
    spanName: string,
    spanKind: SpanKind,
    attributes: api.Attributes,
    links: ReadonlyArray<{ context: api.Context; attributes?: api.Attributes }>
  ): api.SamplingResult {
    // Extract conversation ID from baggage or attributes
    const conversationId = this.extractConversationId(ctx, attributes, links);
    
    // If no conversation ID, fall back to parent-based or rate-based sampling
    if (!conversationId) {
      return this.fallbackSample(ctx, traceId, spanName, spanKind, attributes, links);
    }

    // Check cache for existing decision
    const cached = this.conversationCache.get(conversationId);
    if (cached) {
      return cached;
    }

    // Make sampling decision for this conversation
    const decision = this.makeDecision();
    const result: api.SamplingResult = {
      decision,
      attributes: decision === api.SamplingDecision.RECORD_AND_SAMPLE ? attributes : undefined,
    };

    // Cache the decision
    this.cacheDecision(conversationId, result);
    
    return result;
  }

  getConversationDecision(conversationId: string): api.SamplingResult | undefined {
    return this.conversationCache.get(conversationId);
  }

  setConversationDecision(conversationId: string, decision: api.SamplingResult): void {
    this.cacheDecision(conversationId, decision);
  }

  clearConversationDecision(conversationId: string): void {
    this.conversationCache.delete(conversationId);
  }

  // ─── Private Methods ────────────────────────────────────────────────────────

  private extractConversationId(
    ctx: api.Context,
    attributes: api.Attributes,
    links: ReadonlyArray<{ context: api.Context; attributes?: api.Attributes }>
  ): string | undefined {
    // 1. Baggage on this context (safe — real Context has no ContextAPI.getValue)
    try {
      const baggage = getBaggage(ctx);
      if (baggage?.["gen_ai.conversation.id"]) {
        return baggage["gen_ai.conversation.id"];
      }
    } catch {
      // ignore — fall through to attributes
    }

    // 2. Span attributes
    if (attributes?.["gen_ai.conversation.id"]) {
      return String(attributes["gen_ai.conversation.id"]);
    }

    // 3. Check parent context via links
    for (const link of links ?? []) {
      try {
        const linkBaggage = getBaggage(link.context);
        if (linkBaggage?.["gen_ai.conversation.id"]) {
          return linkBaggage["gen_ai.conversation.id"];
        }
      } catch {
        // ignore
      }
      if (link.attributes?.["gen_ai.conversation.id"]) {
        return String(link.attributes["gen_ai.conversation.id"]);
      }
    }

    // 4. Check parent span context baggage
    try {
      const parentSpan = trace.getSpan(ctx);
      if (parentSpan) {
        const parentContext = trace.setSpan(ROOT_CONTEXT, parentSpan);
        const parentBaggage = getBaggage(parentContext);
        if (parentBaggage?.["gen_ai.conversation.id"]) {
          return parentBaggage["gen_ai.conversation.id"];
        }
      }
    } catch {
      // ignore
    }

    return undefined;
  }

  private fallbackSample(
    ctx: api.Context,
    traceId: string,
    spanName: string,
    spanKind: SpanKind,
    attributes: api.Attributes,
    links: ReadonlyArray<{ context: api.Context; attributes?: api.Attributes }>
  ): api.SamplingResult {
    if (this.parentBased) {
      return this.parentSampler.shouldSample(ctx, traceId, spanName, spanKind, attributes, links);
    }
    return this.makeRateBasedResult();
  }

  private makeDecision(): api.SamplingDecision {
    if (this.rate >= 1.0) return api.SamplingDecision.RECORD_AND_SAMPLE;
    if (this.rate <= 0) return api.SamplingDecision.DROP;
    return Math.random() < this.rate ? api.SamplingDecision.RECORD_AND_SAMPLE : api.SamplingDecision.DROP;
  }

  private makeRateBasedResult(): api.SamplingResult {
    const decision = this.makeDecision();
    return { decision };
  }

  private cacheDecision(conversationId: string, result: api.SamplingResult): void {
    // LRU eviction if cache is full
    if (this.conversationCache.size >= this.maxCacheSize) {
      const firstKey = this.conversationCache.keys().next().value;
      if (firstKey) {
        this.conversationCache.delete(firstKey);
      }
    }
    this.conversationCache.set(conversationId, result);
  }
}

// ─── Parent-Based Sampler (fallback) ──────────────────────────────────────────

class ParentBasedSampler implements api.Sampler {
  private readonly rate: number;

  constructor(rate: number) {
    this.rate = rate;
  }

  shouldSample(
    ctx: api.Context,
    traceId: string,
    spanName: string,
    spanKind: SpanKind,
    attributes: api.Attributes,
    links: ReadonlyArray<{ context: api.Context; attributes?: api.Attributes }>
  ): api.SamplingResult {
    const parentContext = trace.getSpan(ctx) ? trace.setSpan(ROOT_CONTEXT, trace.getSpan(ctx)!) : ctx;
    const parentSpanContext = trace.getSpanContext(parentContext);

    // If parent is sampled, sample this span
    if (parentSpanContext && (parentSpanContext.traceFlags & 1)) {
      return { decision: api.SamplingDecision.RECORD_AND_SAMPLE };
    }

    // If parent is not sampled, don't sample
    if (parentSpanContext) {
      return { decision: api.SamplingDecision.DROP };
    }

    // No parent - use rate-based sampling
    return this.rateBasedSample();
  }

  private rateBasedSample(): api.SamplingResult {
    if (this.rate >= 1.0) return { decision: api.SamplingDecision.RECORD_AND_SAMPLE };
    if (this.rate <= 0) return { decision: api.SamplingDecision.DROP };
    return {
      decision: Math.random() < this.rate ? api.SamplingDecision.RECORD_AND_SAMPLE : api.SamplingDecision.DROP,
    };
  }
}

// ─── Always Sample Sampler (for testing) ──────────────────────────────────────

export class AlwaysSampleSampler implements api.Sampler {
  shouldSample(): api.SamplingResult {
    return { decision: api.SamplingDecision.RECORD_AND_SAMPLE };
  }
}

// ─── Never Sample Sampler (for testing) ───────────────────────────────────────

export class NeverSampleSampler implements api.Sampler {
  shouldSample(): api.SamplingResult {
    return { decision: api.SamplingDecision.DROP };
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createConversationAwareSampler(
  rate: number = 1.0,
  parentBased: boolean = true
): ConversationAwareSampler {
  return new ConversationAwareSampler(rate, parentBased);
}

// ─── Export ───────────────────────────────────────────────────────────────────

export type { api as SamplingApi };