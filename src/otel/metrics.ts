/**
 * opencode-otel-plugin - Metrics Export
 *
 * PeriodicExportingMetricReader for GenAI agent metrics + official catalog.
 */

import type { RequiredConfig } from "../config.js";
import { createMetricsExporter, getMetricsEndpoint } from "./exporter.js";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION, ATTR_DEPLOYMENT_ENVIRONMENT_NAME } from "@opentelemetry/semantic-conventions";

// ─── Metric Names (official catalog) ──────────────────────────────────────────

export const METRIC_NAMES = {
  // GenAI semconv (instrument base names; counters use .input/.output suffixes)
  TOKEN_USAGE: 'gen_ai.client.token.usage',
  TOKEN_USAGE_INPUT: 'gen_ai.client.token.usage',
  TOKEN_USAGE_OUTPUT: 'gen_ai.client.token.usage',
  TOKEN_USAGE_TOTAL: 'gen_ai.client.token.usage',
  INVOCATION_COUNT: 'gen_ai.client.invocation.count',
  OPERATION_DURATION: 'gen_ai.client.operation.duration',
  ERROR_COUNT: 'gen_ai.client.error.count',
  // Official product catalog (15 instruments)
  SESSION_COUNT: 'session.count',
  COST_USAGE: 'cost.usage',
  LINES_OF_CODE_COUNT: 'lines_of_code.count',
  LINES_OF_CODE_TOTAL: 'lines_of_code.total',
  COMMIT_COUNT: 'commit.count',
  TOOL_DURATION: 'tool.duration',
  CACHE_COUNT: 'cache.count',
  SESSION_DURATION: 'session.duration',
  MESSAGE_COUNT: 'message.count',
  SESSION_TOKEN_TOTAL: 'session.token.total',
  SESSION_COST_TOTAL: 'session.cost.total',
  MODEL_USAGE: 'model.usage',
  RETRY_COUNT: 'retry.count',
  SUBTASK_COUNT: 'subtask.count',
} as const;

export type MetricName = (typeof METRIC_NAMES)[keyof typeof METRIC_NAMES];

// ─── Metric Setup ─────────────────────────────────────────────────────────────

export interface MetricsSetupResult {
  meterProvider: any;
  shutdown: () => Promise<void>;
  forceFlush: () => Promise<void>;
}

export async function createMetricsSetup(config: RequiredConfig, sharedResource?: any): Promise<MetricsSetupResult | null> {
  try {
    const { MeterProvider } = await import("@opentelemetry/sdk-metrics");
    const { PeriodicExportingMetricReader } = await import("@opentelemetry/sdk-metrics");

    const resource = sharedResource ?? resourceFromAttributes({
      [ATTR_SERVICE_NAME]: config.serviceName,
      [ATTR_SERVICE_VERSION]: config.serviceVersion,
      [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: config.environment,
    });

    const exporter = await createMetricsExporter(config);

    // PeriodicExportingMetricReader requires exportIntervalMillis >= exportTimeoutMillis.
    // Batch timeout (30s default) is for traces/logs; metrics must clamp to the interval.
    const exportIntervalMillis = Math.max(1, config.batch.scheduledDelayMillis ?? 5000);
    const exportTimeoutMillis = Math.min(
      Math.max(1, config.batch.exportTimeoutMillis ?? exportIntervalMillis),
      exportIntervalMillis,
    );

    const metricReader = new PeriodicExportingMetricReader({
      exporter,
      exportIntervalMillis,
      exportTimeoutMillis,
    });

    const meterProvider = new MeterProvider({
      resource,
      readers: [metricReader],
    });

    return {
      meterProvider,
      shutdown: async () => {
        await meterProvider.shutdown();
      },
      forceFlush: async () => {
        await meterProvider.forceFlush();
      },
    };
  } catch (error) {
    console.error('[otel] Failed to setup metrics:', error);
    return null;
  }
}

// ─── GenAI Metrics Helper (official catalog) ─────────────────────────────────

export class GenAIMetrics {
  private meter: any;
  private metricPrefix: string;
  private instruments: Record<string, any> = {};
  private disabledMetrics: Set<string>;

  constructor(meterProvider: any, options?: { metricPrefix?: string; disabledMetrics?: string[] }) {
    this.meter = meterProvider.getMeter('opencode-otel-plugin');
    this.metricPrefix = options?.metricPrefix ?? '';
    this.disabledMetrics = new Set(options?.disabledMetrics ?? []);
    this.initMetrics();
  }

  private name(base: string): string {
    return this.metricPrefix ? `${this.metricPrefix}${base}` : base;
  }

  private createCounter(base: string, description: string, unit: string): any {
    if (this.disabledMetrics.has(base)) return null;
    return this.meter.createCounter(this.name(base), { description, unit });
  }

  private createHistogram(base: string, description: string, unit: string): any {
    if (this.disabledMetrics.has(base)) return null;
    return this.meter.createHistogram(this.name(base), { description, unit });
  }

  private initMetrics(): void {
    // GenAI semconv counters (existing API surface — instrument names use .input/.output)
    this.instruments.tokenUsageInput = this.createCounter('gen_ai.client.token.usage.input', 'Input token usage for GenAI operations', 'tokens');
    this.instruments.tokenUsageOutput = this.createCounter('gen_ai.client.token.usage.output', 'Output token usage for GenAI operations', 'tokens');
    this.instruments.invocationCount = this.createCounter(METRIC_NAMES.INVOCATION_COUNT, 'Count of GenAI client invocations', 'invocations');
    this.instruments.operationDuration = this.createHistogram(METRIC_NAMES.OPERATION_DURATION, 'Duration of GenAI operations', 'ms');
    this.instruments.errorCount = this.createCounter(METRIC_NAMES.ERROR_COUNT, 'Count of GenAI client errors', 'errors');

    // Official catalog
    this.instruments.sessionCount = this.createCounter(METRIC_NAMES.SESSION_COUNT, 'Number of sessions', 'sessions');
    this.instruments.tokenUsage = this.createCounter(METRIC_NAMES.TOKEN_USAGE, 'Total token usage', 'tokens');
    this.instruments.costUsage = this.createCounter(METRIC_NAMES.COST_USAGE, 'Total cost in USD', 'USD');
    this.instruments.linesOfCodeCount = this.createCounter(METRIC_NAMES.LINES_OF_CODE_COUNT, 'Lines of code changed (event count)', 'lines');
    this.instruments.linesOfCodeTotal = this.createCounter(METRIC_NAMES.LINES_OF_CODE_TOTAL, 'Total lines of code changed', 'lines');
    this.instruments.commitCount = this.createCounter(METRIC_NAMES.COMMIT_COUNT, 'Number of commits', 'commits');
    this.instruments.toolDuration = this.createHistogram(METRIC_NAMES.TOOL_DURATION, 'Tool execution duration', 'ms');
    this.instruments.cacheCount = this.createCounter(METRIC_NAMES.CACHE_COUNT, 'Cache hit/miss count', 'operations');
    this.instruments.sessionDuration = this.createHistogram(METRIC_NAMES.SESSION_DURATION, 'Session duration', 'ms');
    this.instruments.messageCount = this.createCounter(METRIC_NAMES.MESSAGE_COUNT, 'Number of messages', 'messages');
    this.instruments.sessionTokenTotal = this.createHistogram(METRIC_NAMES.SESSION_TOKEN_TOTAL, 'Total tokens per session', 'tokens');
    this.instruments.sessionCostTotal = this.createHistogram(METRIC_NAMES.SESSION_COST_TOTAL, 'Total cost per session', 'USD');
    this.instruments.modelUsage = this.createCounter(METRIC_NAMES.MODEL_USAGE, 'Model invocation usage', 'invocations');
    this.instruments.retryCount = this.createCounter(METRIC_NAMES.RETRY_COUNT, 'Number of retries', 'retries');
    this.instruments.subtaskCount = this.createCounter(METRIC_NAMES.SUBTASK_COUNT, 'Number of subtasks/delegations', 'subtasks');
  }

  recordTokenUsage(input: number, output: number, attributes: Record<string, string | number> = {}): void {
    this.instruments.tokenUsageInput?.add(input, attributes);
    this.instruments.tokenUsageOutput?.add(output, attributes);
    this.instruments.tokenUsage?.add(input + output, attributes);
  }

  recordInvocation(attributes: Record<string, string | number> = {}): void {
    this.instruments.invocationCount?.add(1, attributes);
  }

  recordDuration(durationMs: number, attributes: Record<string, string | number> = {}): void {
    this.instruments.operationDuration?.record(durationMs, attributes);
  }

  recordError(attributes: Record<string, string | number> = {}): void {
    this.instruments.errorCount?.add(1, attributes);
  }

  // ─── Official catalog methods ──────────────────────────────────────────────

  recordSessionCount(attributes: Record<string, string | number> = {}): void {
    this.instruments.sessionCount?.add(1, attributes);
  }

  recordCost(costUsd: number, attributes: Record<string, string | number> = {}): void {
    if (costUsd > 0) this.instruments.costUsage?.add(costUsd, attributes);
  }

  recordLinesOfCode(linesAdded: number, linesRemoved: number, attributes: Record<string, string | number> = {}): void {
    const total = Math.abs(linesAdded) + Math.abs(linesRemoved);
    this.instruments.linesOfCodeCount?.add(1, { ...attributes, 'file.lines_added': linesAdded, 'file.lines_removed': linesRemoved });
    this.instruments.linesOfCodeTotal?.add(total, attributes);
  }

  recordCommit(attributes: Record<string, string | number> = {}): void {
    this.instruments.commitCount?.add(1, attributes);
  }

  recordToolDuration(durationMs: number, attributes: Record<string, string | number> = {}): void {
    this.instruments.toolDuration?.record(durationMs, attributes);
  }

  recordCache(hit: boolean, attributes: Record<string, string | number> = {}): void {
    this.instruments.cacheCount?.add(1, { ...attributes, 'cache.hit': hit });
  }

  recordSessionDuration(durationMs: number, attributes: Record<string, string | number> = {}): void {
    this.instruments.sessionDuration?.record(durationMs, attributes);
  }

  recordMessage(attributes: Record<string, string | number> = {}): void {
    this.instruments.messageCount?.add(1, attributes);
  }

  recordSessionTokenTotal(totalTokens: number, attributes: Record<string, string | number> = {}): void {
    this.instruments.sessionTokenTotal?.record(totalTokens, attributes);
  }

  recordSessionCostTotal(costUsd: number, attributes: Record<string, string | number> = {}): void {
    this.instruments.sessionCostTotal?.record(costUsd, attributes);
  }

  recordModelUsage(attributes: Record<string, string | number> = {}): void {
    this.instruments.modelUsage?.add(1, attributes);
  }

  recordRetry(attributes: Record<string, string | number> = {}): void {
    this.instruments.retryCount?.add(1, attributes);
  }

  recordSubtask(attributes: Record<string, string | number> = {}): void {
    this.instruments.subtaskCount?.add(1, attributes);
  }
}
