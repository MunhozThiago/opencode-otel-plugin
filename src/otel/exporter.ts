/**
 * opencode-otel-plugin - OTLP Exporter Configuration
 * 
 * Configures OTLP exporters for traces, metrics, and logs.
 */

import type { RequiredConfig } from "../config.js";
import {
  DynamicHeaders,
  wrapExporterWithAuthRetry,
  type HeadersMap,
  resolveHeadersHelper,
} from "./headers.js";

// ─── Protocol / URL helpers ───────────────────────────────────────────────────

export type ExportProtocol = 'http' | 'grpc' | 'http/protobuf' | 'http/json';

/**
 * Build OTLP HTTP signal URL from base endpoint + signal path.
 * Replaces brittle string replace for multi-protocol support.
 */
export function buildHttpSignalUrl(endpoint: string, signal: 'traces' | 'metrics' | 'logs'): string {
  let base = endpoint.replace(/\/+$/, '');
  // Strip any existing signal path
  base = base.replace(/\/v1\/(traces|metrics|logs)$/, '');
  // If endpoint already has a path that isn't /v1, append under it
  if (base.endsWith('/v1')) {
    return `${base}/${signal}`;
  }
  return `${base}/v1/${signal}`;
}

function getDynamicHeaders(config: RequiredConfig): DynamicHeaders {
  const helper = resolveHeadersHelper(config.headersHelper);
  return new DynamicHeaders(config.headers || {}, helper);
}

function maybeAuthRetry<T extends { export: (...args: any[]) => any; shutdown?: () => Promise<void>; forceFlush?: () => Promise<void> }>(
  config: RequiredConfig,
  makeExporter: (headers: HeadersMap) => T
): T {
  if (!config.headersHelper) {
    return makeExporter(config.headers || {});
  }
  const dyn = getDynamicHeaders(config);
  return wrapExporterWithAuthRetry(makeExporter, dyn);
}

// ─── Trace Exporter ───────────────────────────────────────────────────────────

export async function createTraceExporter(config: RequiredConfig) {
  if (config.disabledTraces) {
    // Return a no-op exporter
    return {
      export(_spans: any[], resultCallback: (result: { code: number }) => void) {
        resultCallback({ code: 0 });
      },
      shutdown: async () => {},
      forceFlush: async () => {},
    };
  }

  if (config.protocol === 'grpc') {
    const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-grpc");
    return maybeAuthRetry(config, (headers) => new OTLPTraceExporter({
      url: config.endpoint.replace('/v1/traces', ''),
      headers,
      timeout: config.batch.exportTimeoutMillis,
    }));
  } else {
    const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
    return maybeAuthRetry(config, (headers) => new OTLPTraceExporter({
      url: config.endpoint,
      headers,
      timeout: config.batch.exportTimeoutMillis,
    }));
  }
}

// ─── Metrics Exporter ─────────────────────────────────────────────────────────

export async function createMetricsExporter(config: RequiredConfig) {
  const metricsEndpoint = buildHttpSignalUrl(config.endpoint, 'metrics');

  if (config.protocol === 'grpc') {
    const { OTLPMetricExporter } = await import("@opentelemetry/exporter-metrics-otlp-grpc");
    if (config.metricsTemporality === 'delta') {
      process.env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY =
        process.env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY || 'delta';
    }
    return maybeAuthRetry(config, (headers) => new OTLPMetricExporter({
      url: config.endpoint.replace('/v1/traces', ''),
      headers,
      timeout: config.batch.exportTimeoutMillis,
    }));
  } else {
    const { OTLPMetricExporter } = await import("@opentelemetry/exporter-metrics-otlp-http");
    if (config.metricsTemporality === 'delta') {
      // Bridge to standard OTEL env (supported by metric exporters)
      process.env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY =
        process.env.OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY || 'delta';
    }
    return maybeAuthRetry(config, (headers) => new OTLPMetricExporter({
      url: metricsEndpoint,
      headers,
      timeout: config.batch.exportTimeoutMillis,
    }));
  }
}

// ─── Logs Exporter ────────────────────────────────────────────────────────────

export async function createLogsExporter(config: RequiredConfig) {
  if (config.disabledLogs) {
    return {
      export(_records: any[], resultCallback: (result: { code: number }) => void) {
        resultCallback({ code: 0 });
      },
      shutdown: async () => {},
      forceFlush: async () => {},
    };
  }

  const logsEndpoint = buildHttpSignalUrl(config.endpoint, 'logs');

  if (config.protocol === 'grpc') {
    const { OTLPLogExporter } = await import("@opentelemetry/exporter-logs-otlp-grpc");
    return maybeAuthRetry(config, (headers) => new OTLPLogExporter({
      url: config.endpoint.replace('/v1/traces', ''),
      headers,
      timeout: config.batch.exportTimeoutMillis,
    }));
  } else {
    const { OTLPLogExporter } = await import("@opentelemetry/exporter-logs-otlp-http");
    return maybeAuthRetry(config, (headers) => new OTLPLogExporter({
      url: logsEndpoint,
      headers,
      timeout: config.batch.exportTimeoutMillis,
    }));
  }
}

// ─── Endpoint Helpers ─────────────────────────────────────────────────────────

export function getMetricsEndpoint(endpoint: string): string {
  return buildHttpSignalUrl(endpoint, 'metrics');
}

export function getLogsEndpoint(endpoint: string): string {
  return buildHttpSignalUrl(endpoint, 'logs');
}

export function getBaseEndpoint(endpoint: string, protocol: 'http' | 'grpc'): string {
  if (protocol === 'grpc') {
    return endpoint.replace('/v1/traces', '');
  }
  return endpoint;
}
