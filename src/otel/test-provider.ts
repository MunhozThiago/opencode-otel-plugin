/**
 * opencode-otel-plugin - Test Provider Setup
 * 
 * Test-specific provider setup that uses a mock exporter instead of OTLP.
 */

import { NodeTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION, ATTR_DEPLOYMENT_ENVIRONMENT_NAME, ATTR_TELEMETRY_SDK_LANGUAGE, ATTR_TELEMETRY_SDK_NAME, ATTR_TELEMETRY_SDK_VERSION } from "@opentelemetry/semantic-conventions";
import { context, propagation, trace } from "@opentelemetry/api";
import type { Span, SpanContext, Attributes } from "@opentelemetry/api";
import type { SpanProcessor, ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";
import type { RequiredConfig, OtelPluginOptions } from "../config.js";
import { ConversationAwareSampler, createConversationAwareSampler } from "./sampler.js";
import { createBaggagePropagator } from "./baggage.js";
import { PIIRedactor, createPIIRedactor } from "../utils/pii.js";
import type { GenAIAttributes } from "../types.js";

// ─── Mock Span Exporter for Tests ────────────────────────────────────────────────

export class MockSpanExporter {
  private spans: ReadableSpan[] = [];

  async export(spans: ReadableSpan[], resultCallback: (result: { code: number }) => void): Promise<void> {
    this.spans.push(...spans);
    resultCallback({ code: 0 }); // SUCCESS
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  getSpans(): ReadableSpan[] {
    return this.spans;
  }

  clear(): void {
    this.spans = [];
  }
}

// ─── Custom Span Processor for PII Redaction & Enrichment ─────────────────────

export class EnrichmentSpanProcessor implements SpanProcessor {
  private readonly piiRedactor: PIIRedactor;
  private readonly debug: boolean;

  constructor(piiRedactor: PIIRedactor, debug: boolean = false) {
    this.piiRedactor = piiRedactor;
    this.debug = debug;
  }

  onStart(span: Span, parentContext: SpanContext): void {
    // No-op for start
  }

  onEnd(span: ReadableSpan): void {
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

// ─── Provider Factory ──────────────────────────────────────────────────────────

export interface ProviderSetupResult {
  provider: NodeTracerProvider;
  sampler: any;
  piiRedactor: PIIRedactor;
  exporter: MockSpanExporter;
  shutdown: () => Promise<void>;
}

export async function createTestProvider(config: any): Promise<ProviderSetupResult> {
  // 1. Create resource with service metadata
  const resource = createTestResource(config);

  // 2. Create sampler
  const sampler = createConversationAwareSampler(config.sampling?.rate ?? 1.0, config.sampling?.parentBased ?? true);

  // 3. Create PII redactor
  const piiRedactor = createPIIRedactor(config.piiRedaction as any);

  // 4. Create mock exporter for tests
  const exporter = new MockSpanExporter();

  // 5. Create batch span processor
  const batchProcessor = new BatchSpanProcessor(exporter, {
    maxQueueSize: 2048,
    maxExportBatchSize: 512,
    scheduledDelayMillis: 5000,
    exportTimeoutMillis: 30000,
  });

  // 6. Enrichment processor
  const enrichmentProcessor = new EnrichmentSpanProcessor(piiRedactor, config.debug);

  // OTel 2.x: processors passed to constructor
  const provider = new NodeTracerProvider({
    resource,
    sampler,
    spanProcessors: [enrichmentProcessor, batchProcessor],
    spanLimits: {
      attributeCountLimit: 128,
      attributeValueLengthLimit: 4096,
      eventCountLimit: 128,
      linkCountLimit: 128,
    },
  });

  // 7. Register context manager for async propagation
  const contextManager = new AsyncHooksContextManager();
  contextManager.enable();

  // 8. Register global propagators (W3C TraceContext + Baggage)
  propagation.setGlobalPropagator(createBaggagePropagator());

  // 9. Register provider globally (OTel 2.x uses register())
  provider.register();

  // 10. Return shutdown function
  const shutdown = async (): Promise<void> => {
    await provider.forceFlush();
    await provider.shutdown();
    contextManager.disable();
  };

  return {
    provider,
    sampler,
    piiRedactor,
    exporter,
    shutdown,
  };
}

// ─── Resource Creation ────────────────────────────────────────────────────────

function createTestResource(config: any): any {
  const attributes: Record<string, string> = {
    "service.name": config.serviceName ?? "opencode-test",
    "service.version": config.serviceVersion ?? "test",
    "deployment.environment": config.environment ?? "test",
    "telemetry.sdk.language": "nodejs",
    "telemetry.sdk.name": "opentelemetry",
    "telemetry.sdk.version": "1.30.0",
  };

  // Add custom resource attributes
  for (const [key, value] of Object.entries(config.resourceAttributes ?? {})) {
    attributes[key] = value as string;
  }

  return resourceFromAttributes(attributes);
}

// ─── Attribute Enrichment Helper ──────────────────────────────────────────────

export function enrichSpanAttributes(
  span: any,
  attributes: any,
  piiRedactor: any
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

// ─── Export ───────────────────────────────────────────────────────────────────

export { BatchSpanProcessor };
export type { ReadableSpan, SpanContext };