/**
 * opencode-otel-plugin - OpenTelemetry Provider Setup
 * 
 * Configures the OpenTelemetry SDK with GenAI semantic conventions,
 * custom sampler, batch processor, and OTLP exporters.
 */

import { NodeTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION, ATTR_DEPLOYMENT_ENVIRONMENT_NAME, ATTR_TELEMETRY_SDK_LANGUAGE, ATTR_TELEMETRY_SDK_NAME, ATTR_TELEMETRY_SDK_VERSION } from "@opentelemetry/semantic-conventions";
import { context, propagation, trace } from "@opentelemetry/api";
import type { Span, SpanContext, Attributes } from "@opentelemetry/api";
import type { SpanProcessor, ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";
import { hostname as nodeHostname } from "node:os";
import type { RequiredConfig, OtelPluginOptions } from "../config.js";
import { ConversationAwareSampler, createConversationAwareSampler } from "./sampler.js";
import { createBaggagePropagator } from "./baggage.js";
import { PIIRedactor, createPIIRedactor } from "../utils/pii.js";
import type { GenAIAttributes } from "../types.js";
import { createTraceExporter } from "./exporter.js";
import { createMetricsSetup, GenAIMetrics } from "./metrics.js";
import { createLogsSetup, AgentLogger } from "./logs.js";
import { EnrichmentSpanProcessor as ProcessorEnrichmentSpanProcessor } from "./processor.js";
import { createPersistenceProcessor, type LocalSpanStore, type PersistenceSpanProcessor } from "./persistence.js";

// ─── Re-export EnrichmentSpanProcessor from processor.ts ──────────────────────

export { EnrichmentSpanProcessor } from "./processor.js";

// ─── Provider Factory ──────────────────────────────────────────────────────────

export interface ProviderSetupResult {
  provider: NodeTracerProvider;
  sampler: ConversationAwareSampler;
  piiRedactor: PIIRedactor;
  metrics?: GenAIMetrics | null;
  logs?: AgentLogger | null;
  persistence?: { store: LocalSpanStore; processor: PersistenceSpanProcessor } | null;
  metricsSetup?: any;
  logsSetup?: any;
  forceFlush: () => Promise<void>;
  shutdown: () => Promise<void>;
}

export async function createProvider(config: RequiredConfig): Promise<ProviderSetupResult> {
  // 1. Create resource with service metadata
  const resource = createResource(config);

  // 2. Create sampler
  const sampler = createConversationAwareSampler(config.sampling.rate, config.sampling.parentBased);

  // 3. Create PII redactor
  const piiRedactor = createPIIRedactor(config.piiRedaction as any);

  // 4. Create OTLP exporter
  const exporter = await createTraceExporter(config);

  // 5. Create batch span processor
  const batchProcessor = new BatchSpanProcessor(exporter, {
    maxQueueSize: config.batch.maxQueueSize,
    maxExportBatchSize: config.batch.maxExportBatchSize,
    scheduledDelayMillis: config.batch.scheduledDelayMillis,
    exportTimeoutMillis: config.batch.exportTimeoutMillis,
  });

  // 6. Enrichment processor (debug logging + configured spanAttributes on start)
  const enrichmentProcessor = new ProcessorEnrichmentSpanProcessor(
    piiRedactor,
    config.debug,
    (config.spanAttributes || {}) as Attributes
  );

  // 6b. Optional local persistence (durable buffer; gap #9)
  let persistence: { store: LocalSpanStore; processor: PersistenceSpanProcessor } | null = null;
  try {
    persistence = createPersistenceProcessor({
      enabled: config.persistence?.enabled ?? false,
      directory: config.persistence?.directory,
      maxInMemory: config.persistence?.maxInMemory,
      maxSpans: config.persistence?.maxSpans,
    });
    if (config.debug && persistence) {
      console.log('[otel] Persistence layer enabled');
    }
  } catch (error) {
    if (config.debug) {
      console.warn('[otel] Persistence setup failed (optional):', error);
    }
    persistence = null;
  }

  // OTel 2.x: span processors are passed to the constructor (no addSpanProcessor)
  const spanProcessors = persistence
    ? [enrichmentProcessor, batchProcessor, persistence.processor]
    : [enrichmentProcessor, batchProcessor];

  // 7. Create tracer provider
  const provider = new NodeTracerProvider({
    resource,
    sampler,
    spanProcessors,
    spanLimits: {
      attributeCountLimit: 128,
      attributeValueLengthLimit: 4096,
      eventCountLimit: 128,
      linkCountLimit: 128,
    },
  });

  // 8. Register context manager for async propagation
  const contextManager = new AsyncHooksContextManager();
  contextManager.enable();

  // 9. Register global propagators (W3C TraceContext + Baggage)
  propagation.setGlobalPropagator(createBaggagePropagator());

  // 10. Register provider globally (OTel 2.x uses register())
  provider.register();

  // 11. Setup metrics (optional - fails gracefully)
  let metricsSetup: any = null;
  let genAIMetrics: GenAIMetrics | null = null;
  try {
    metricsSetup = await createMetricsSetup(config, resource);
    if (metricsSetup) {
      genAIMetrics = new GenAIMetrics(metricsSetup.meterProvider, {
        metricPrefix: config.metricPrefix,
        disabledMetrics: config.disabledMetrics,
      });
      // Global meter provider registration (P2)
      try {
        const api = await import("@opentelemetry/api");
        (api as any).metrics?.setGlobalMeterProvider?.(metricsSetup.meterProvider);
      } catch { /* optional */ }
    }
  } catch (error) {
    if (config.debug) {
      console.warn('[otel] Metrics setup failed (optional):', error);
    }
  }

  // 12. Setup logs (optional - fails gracefully)
  let logsSetup: any = null;
  let agentLogger: AgentLogger | null = null;
  try {
    if (!config.disabledLogs) {
      logsSetup = await createLogsSetup(config, resource);
      if (logsSetup) {
        agentLogger = new AgentLogger(logsSetup.logger, {
          logsEnabled: config.logsEnabled ?? true,
          capturePromptInLogs: config.capturePromptInLogs ?? false,
        });
        // Global logger provider registration (P2)
        try {
          const apiLogs = await import("@opentelemetry/api-logs");
          (apiLogs as any).logs?.setGlobalLoggerProvider?.(logsSetup.loggerProvider);
        } catch { /* optional */ }
      }
    }
  } catch (error) {
    if (config.debug) {
      console.warn('[otel] Logs setup failed (optional):', error);
    }
  }

  // 13. forceFlush for lifecycle events (idle/error/message-complete/signals)
  const forceFlush = async (): Promise<void> => {
    try {
      await provider.forceFlush();
    } catch (e) {
      if (config.debug) console.warn('[otel] provider forceFlush failed:', e);
    }
    if (metricsSetup?.forceFlush) {
      try { await metricsSetup.forceFlush(); } catch { /* ignore */ }
    }
    if (logsSetup?.forceFlush) {
      try { await logsSetup.forceFlush(); } catch { /* ignore */ }
    }
  };

  // 14. Shutdown
  const shutdown = async (): Promise<void> => {
    await provider.forceFlush();
    await provider.shutdown();
    if (metricsSetup) {
      try { await metricsSetup.shutdown(); } catch { /* ignore */ }
    }
    if (logsSetup) {
      try { await logsSetup.shutdown(); } catch { /* ignore */ }
    }
    contextManager.disable();
  };

  return {
    provider,
    sampler,
    piiRedactor,
    metrics: genAIMetrics,
    logs: agentLogger,
    persistence,
    metricsSetup,
    logsSetup,
    forceFlush,
    shutdown,
  };
}

// ─── Resource Creation ────────────────────────────────────────────────────────

function createResource(config: RequiredConfig) {
  const hostName = nodeHostname();
  const attributes: Record<string, string> = {
    [ATTR_SERVICE_NAME]: config.serviceName,
    [ATTR_SERVICE_VERSION]: config.serviceVersion,
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: config.environment,
    [ATTR_TELEMETRY_SDK_LANGUAGE]: "nodejs",
    [ATTR_TELEMETRY_SDK_NAME]: "opentelemetry",
    [ATTR_TELEMETRY_SDK_VERSION]: "2.11.0",
    // Host identity (P2: unified resource with os.type / host.arch)
    "os.type": process.platform,
    "host.arch": process.arch,
    "host.name": hostName,
    "process.pid": String(process.pid),
    "service.instance.id": `${hostName}-${process.pid}`,
    // project.id common attribute when provided via resourceAttributes
    ...(config.resourceAttributes?.["project.id"]
      ? { "project.id": config.resourceAttributes["project.id"] }
      : {}),
  };

  // Add custom resource attributes
  for (const [key, value] of Object.entries(config.resourceAttributes)) {
    attributes[key] = value;
  }

  return resourceFromAttributes(attributes);
}

// ─── Attribute Enrichment Helper ──────────────────────────────────────────────

export function enrichSpanAttributes(
  span: Span,
  attributes: GenAIAttributes,
  piiRedactor: PIIRedactor
): void {
  // Apply PII redaction - cast through unknown to avoid type conflicts
  const redacted = piiRedactor.redactAttributes(attributes as unknown as Attributes);
  
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