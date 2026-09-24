/**
 * opencode-otel-plugin - Configuration
 * 
 * Default configuration and validation for the plugin.
 */

import type { OtelPluginOptions } from "./types.js";

// ─── Default Configuration ────────────────────────────────────────────────────

const DEFAULT_ENDPOINT = "http://localhost:4318/v1/traces";
const DEFAULT_PROTOCOL = "http" as const;
const DEFAULT_SERVICE_NAME = "opencode";
const DEFAULT_ENVIRONMENT = "development";

const DEFAULT_BATCH = {
  maxQueueSize: 2048,
  maxExportBatchSize: 512,
  scheduledDelayMillis: 5000,
  exportTimeoutMillis: 30000,
};

const DEFAULT_SAMPLING = {
  rate: 1.0,
  conversationAware: true,
  parentBased: true,
};

const DEFAULT_PII_REDACTION = {
  enabled: true,
  patterns: [] as RegExp[],
  defaultFields: ["apiKey", "password", "secret", "token", "authorization", "apikey", "access_token", "refresh_token"],
};

const DEFAULT_RESOURCE_ATTRIBUTES: Record<string, string> = {};

const DEFAULT_HEADERS: Record<string, string> = {};

const DEFAULT_DEBUG = false;

const DEFAULT_PERSISTENCE = {
  enabled: false,
  directory: ".opencode-otel/spans",
  maxInMemory: 512,
  maxSpans: 10000,
};

// ─── Environment Config Layer (OPENCODE_* > options > defaults) ──────────────

function parseBool(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  const s = v.trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return undefined;
}

function parseNum(v: string | undefined): number | undefined {
  if (v === undefined || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function parseHeaderPairs(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  const out: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (key) out[key] = val;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseAttrPairs(raw: string | undefined): Record<string, string> | undefined {
  // OTEL_RESOURCE_ATTRIBUTES style: k=v,k2=v2
  return parseHeaderPairs(raw);
}

function parseList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const items = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function envConfig(env: NodeJS.ProcessEnv = process.env): Partial<OtelPluginOptions> {
  const out: Partial<OtelPluginOptions> = {};

  const endpoint = env.OPENCODE_OTEL_ENDPOINT || env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (endpoint) {
    // Normalize bare collector host to /v1/traces for HTTP default
    let ep = endpoint.replace(/\/$/, '');
    if (!/\/v1\/(traces|metrics|logs)$/.test(ep)) {
      const protocol = env.OPENCODE_OTEL_PROTOCOL || env.OTEL_EXPORTER_OTLP_PROTOCOL;
      ep = protocol === 'grpc' ? ep : `${ep}/v1/traces`;
    }
    out.endpoint = ep;
  }

  const protocol = env.OPENCODE_OTEL_PROTOCOL || env.OTEL_EXPORTER_OTLP_PROTOCOL;
  if (protocol === 'http' || protocol === 'grpc' || protocol === 'http/protobuf' || protocol === 'http/json') {
    out.protocol = protocol === 'grpc' ? 'grpc' : 'http';
  }

  if (env.OPENCODE_OTEL_SERVICE_NAME) out.serviceName = env.OPENCODE_OTEL_SERVICE_NAME;
  if (env.OPENCODE_OTEL_SERVICE_VERSION) out.serviceVersion = env.OPENCODE_OTEL_SERVICE_VERSION;
  if (env.OPENCODE_OTEL_ENVIRONMENT) out.environment = env.OPENCODE_OTEL_ENVIRONMENT;
  else if (env.OTEL_RESOURCE_ATTRIBUTES?.includes('deployment.environment=')) {
    // leave to resourceAttributes merge below
  }

  const debug = parseBool(env.OPENCODE_OTEL_DEBUG);
  if (debug !== undefined) out.debug = debug;

  const headers =
    parseHeaderPairs(env.OPENCODE_OTEL_HEADERS) ||
    parseHeaderPairs(env.OTEL_EXPORTER_OTLP_HEADERS);
  if (headers) out.headers = headers;

  const resourceAttrs =
    parseAttrPairs(env.OPENCODE_OTEL_RESOURCE_ATTRIBUTES) ||
    parseAttrPairs(env.OTEL_RESOURCE_ATTRIBUTES);
  if (resourceAttrs) out.resourceAttributes = resourceAttrs;

  const spanAttrs = parseAttrPairs(env.OPENCODE_OTEL_SPAN_ATTRIBUTES);
  if (spanAttrs) out.spanAttributes = spanAttrs;

  if (env.OPENCODE_OTEL_HEADERS_HELPER) out.headersHelper = env.OPENCODE_OTEL_HEADERS_HELPER;
  if (env.OPENCODE_TRACEPARENT) out.traceparent = env.OPENCODE_TRACEPARENT;
  if (env.OPENCODE_TRACESTATE) out.tracestate = env.OPENCODE_TRACESTATE;

  const samplingRate = parseNum(env.OPENCODE_OTEL_SAMPLING_RATE);
  if (samplingRate !== undefined) out.sampling = { rate: samplingRate };

  const maxQueue = parseNum(env.OPENCODE_OTEL_MAX_QUEUE_SIZE);
  const batchDelay = parseNum(env.OPENCODE_OTEL_BATCH_DELAY_MS);
  if (maxQueue !== undefined || batchDelay !== undefined) {
    out.batch = {};
    if (maxQueue !== undefined) out.batch.maxQueueSize = maxQueue;
    if (batchDelay !== undefined) out.batch.scheduledDelayMillis = batchDelay;
  }

  const disabledMetrics = parseList(env.OPENCODE_OTEL_DISABLED_METRICS);
  if (disabledMetrics) out.disabledMetrics = disabledMetrics;

  const disabledTraces = parseBool(env.OPENCODE_OTEL_DISABLED_TRACES);
  if (disabledTraces !== undefined) out.disabledTraces = disabledTraces;

  const disabledLogs = parseBool(env.OPENCODE_OTEL_DISABLED_LOGS);
  if (disabledLogs !== undefined) out.disabledLogs = disabledLogs;

  if (env.OPENCODE_OTEL_METRIC_PREFIX) out.metricPrefix = env.OPENCODE_OTEL_METRIC_PREFIX;

  const temporality = env.OPENCODE_OTEL_METRICS_TEMPORALITY;
  if (temporality === 'cumulative' || temporality === 'delta') {
    out.metricsTemporality = temporality;
  }

  const logsEnabled = parseBool(env.OPENCODE_OTEL_LOGS_ENABLED);
  if (logsEnabled !== undefined) out.logsEnabled = logsEnabled;

  const capturePrompt = parseBool(env.OPENCODE_OTEL_CAPTURE_PROMPT_IN_LOGS);
  if (capturePrompt !== undefined) out.capturePromptInLogs = capturePrompt;

  const persistEnabled = parseBool(env.OPENCODE_OTEL_PERSISTENCE_ENABLED);
  if (persistEnabled !== undefined) out.persistence = { enabled: persistEnabled };

  return out;
}

// ─── Configuration Merge ──────────────────────────────────────────────────────

function mergeConfig(userOptions?: OtelPluginOptions): RequiredConfig {
  const options = userOptions || {};
  const envOpts = envConfig();

  // Precedence: explicit options > env > defaults (shallow for nested partials)
  const pick = <T>(optVal: T | undefined, envVal: T | undefined, def: T): T =>
    optVal !== undefined ? optVal : envVal !== undefined ? envVal : def;

  const endpoint = pick(options.endpoint, envOpts.endpoint, DEFAULT_ENDPOINT);
  const protocol = pick(options.protocol, envOpts.protocol, DEFAULT_PROTOCOL) as 'http' | 'grpc';
  const serviceName = pick(options.serviceName, envOpts.serviceName, DEFAULT_SERVICE_NAME);
  const serviceVersion = pick(options.serviceVersion, envOpts.serviceVersion, "unknown");
  const environment = pick(options.environment, envOpts.environment, DEFAULT_ENVIRONMENT);
  const debug = pick(options.debug, envOpts.debug, DEFAULT_DEBUG);

  const batch = {
    ...DEFAULT_BATCH,
    ...(envOpts.batch || {}),
    ...(options.batch || {}),
  };

  const sampling = {
    ...DEFAULT_SAMPLING,
    ...(envOpts.sampling || {}),
    ...(options.sampling || {}),
  };

  const piiRedaction = {
    ...DEFAULT_PII_REDACTION,
    ...options.piiRedaction,
    patterns: [...DEFAULT_PII_REDACTION.patterns, ...(options.piiRedaction?.patterns || [])],
    defaultFields: [...DEFAULT_PII_REDACTION.defaultFields, ...(options.piiRedaction?.defaultFields || [])],
  };

  const resourceAttributes = {
    ...DEFAULT_RESOURCE_ATTRIBUTES,
    ...(envOpts.resourceAttributes || {}),
    ...(options.resourceAttributes || {}),
  };

  const headers = {
    ...DEFAULT_HEADERS,
    ...(envOpts.headers || {}),
    ...(options.headers || {}),
  };

  const persistence = {
    ...DEFAULT_PERSISTENCE,
    ...(envOpts.persistence || {}),
    ...(options.persistence || {}),
  };

  const spanAttributes = {
    ...(envOpts.spanAttributes || {}),
    ...(options.spanAttributes || {}),
  };

  const disabledMetrics = options.disabledMetrics ?? envOpts.disabledMetrics ?? [];
  const disabledTraces = pick(options.disabledTraces, envOpts.disabledTraces, false);
  const disabledLogs = pick(options.disabledLogs, envOpts.disabledLogs, false);
  const metricPrefix = pick(options.metricPrefix, envOpts.metricPrefix, '');
  const metricsTemporality = pick(options.metricsTemporality, envOpts.metricsTemporality, 'cumulative' as const);
  const logsEnabled = pick(options.logsEnabled, envOpts.logsEnabled, true);
  const capturePromptInLogs = pick(options.capturePromptInLogs, envOpts.capturePromptInLogs, false);
  const headersHelper = pick(options.headersHelper, envOpts.headersHelper, undefined as string | undefined);
  const headersHelperTimeoutMs = pick(options.headersHelperTimeoutMs, envOpts.headersHelperTimeoutMs, 5000);
  const traceparent = pick(options.traceparent, envOpts.traceparent, undefined as string | undefined);
  const tracestate = pick(options.tracestate, envOpts.tracestate, undefined as string | undefined);

  return {
    endpoint,
    protocol,
    serviceName,
    serviceVersion,
    environment,
    batch,
    sampling,
    piiRedaction,
    resourceAttributes,
    persistence,
    debug,
    headers,
    spanAttributes,
    disabledMetrics,
    disabledTraces,
    disabledLogs,
    metricPrefix,
    metricsTemporality,
    logsEnabled,
    capturePromptInLogs,
    headersHelper,
    headersHelperTimeoutMs,
    traceparent,
    tracestate,
  } as RequiredConfig;
}

// ─── Configuration Validation ─────────────────────────────────────────────────

function validateConfig(config: RequiredConfig): void {
  // Validate endpoint
  if (!config.endpoint || typeof config.endpoint !== "string") {
    throw new Error("OTel plugin: endpoint is required and must be a string");
  }
  
  try {
    new URL(config.endpoint);
  } catch {
    throw new Error(`OTel plugin: invalid endpoint URL: ${config.endpoint}`);
  }
  
  // Validate protocol (http | grpc | http/protobuf | http/json)
  const allowedProtocols = ["http", "grpc", "http/protobuf", "http/json"];
  if (!allowedProtocols.includes(config.protocol as string)) {
    throw new Error(`OTel plugin: protocol must be one of ${allowedProtocols.join(', ')}, got: ${config.protocol}`);
  }
  
  // Validate service name
  if (!config.serviceName || typeof config.serviceName !== "string") {
    throw new Error("OTel plugin: serviceName is required and must be a string");
  }

  // Validate serviceVersion (if provided, non-empty string)
  if (config.serviceVersion != null && typeof config.serviceVersion !== "string") {
    throw new Error("OTel plugin: serviceVersion must be a string");
  }
  if (typeof config.serviceVersion === "string" && config.serviceVersion.length === 0) {
    throw new Error("OTel plugin: serviceVersion must not be empty");
  }

  // Validate environment (if provided, non-empty string)
  if (config.environment != null && typeof config.environment !== "string") {
    throw new Error("OTel plugin: environment must be a string");
  }
  if (typeof config.environment === "string" && config.environment.length === 0) {
    throw new Error("OTel plugin: environment must not be empty");
  }

  // Validate endpoint protocol consistency
  if (typeof config.endpoint === "string") {
    let endpointUrl: URL | undefined;
    try {
      endpointUrl = new URL(config.endpoint);
    } catch {
      // already reported above
    }
    if (endpointUrl) {
      if (config.protocol === "grpc" && endpointUrl.protocol !== "http:" && endpointUrl.protocol !== "https:") {
        throw new Error(`OTel plugin: protocol 'grpc' requires an http/https endpoint, got: ${endpointUrl.protocol}`);
      }
      if (config.protocol === "http" && endpointUrl.protocol !== "http:" && endpointUrl.protocol !== "https:") {
        throw new Error(`OTel plugin: protocol 'http' requires an http/https endpoint, got: ${endpointUrl.protocol}`);
      }
      // HTTP OTLP exporter expects path-level endpoints (e.g. /v1/traces); warn-level check
      if (config.protocol === "http" && config.endpoint.includes("4317")) {
        throw new Error("OTel plugin: endpoint appears to target gRPC port 4317; use protocol 'grpc' or HTTP port 4318");
      }
    }
  }

  // Validate headers map
  if (config.headers != null && typeof config.headers !== "object") {
    throw new Error("OTel plugin: headers must be an object of string values");
  }
  if (config.headers) {
    for (const [key, value] of Object.entries(config.headers)) {
      if (typeof key !== "string" || key.length === 0) {
        throw new Error("OTel plugin: header names must be non-empty strings");
      }
      if (typeof value !== "string") {
        throw new Error(`OTel plugin: header value for '${key}' must be a string`);
      }
      // Reject CR/LF to prevent header injection
      if (/[\r\n]/.test(value)) {
        throw new Error(`OTel plugin: header value for '${key}' must not contain CR/LF characters`);
      }
    }
  }

  // Validate resource attributes map
  if (config.resourceAttributes != null && typeof config.resourceAttributes !== "object") {
    throw new Error("OTel plugin: resourceAttributes must be an object of string values");
  }
  if (config.resourceAttributes) {
    for (const [key, value] of Object.entries(config.resourceAttributes)) {
      if (typeof key !== "string" || key.length === 0) {
        throw new Error("OTel plugin: resourceAttributes keys must be non-empty strings");
      }
      if (typeof value !== "string") {
        throw new Error(`OTel plugin: resourceAttributes value for '${key}' must be a string`);
      }
      // OTel attribute keys should not contain spaces or control characters
      if (/\s/.test(key)) {
        throw new Error(`OTel plugin: resourceAttributes key '${key}' must not contain whitespace`);
      }
    }
  }

  // Validate batch config
  if (config.batch?.maxQueueSize != null && config.batch.maxQueueSize <= 0) {
    throw new Error("OTel plugin: batch.maxQueueSize must be > 0");
  }
  if (config.batch?.maxExportBatchSize != null && config.batch.maxExportBatchSize <= 0) {
    throw new Error("OTel plugin: batch.maxExportBatchSize must be > 0");
  }
  if (config.batch?.maxExportBatchSize != null && config.batch?.maxQueueSize != null && config.batch.maxExportBatchSize > config.batch.maxQueueSize) {
    throw new Error("OTel plugin: batch.maxExportBatchSize must not exceed maxQueueSize");
  }
  if (config.batch?.scheduledDelayMillis != null && config.batch.scheduledDelayMillis <= 0) {
    throw new Error("OTel plugin: batch.scheduledDelayMillis must be > 0");
  }
  if (config.batch?.exportTimeoutMillis != null && config.batch.exportTimeoutMillis <= 0) {
    throw new Error("OTel plugin: batch.exportTimeoutMillis must be > 0");
  }
  
  // Validate sampling
  if (config.sampling?.rate != null && (config.sampling.rate < 0 || config.sampling.rate > 1)) {
    throw new Error("OTel plugin: sampling.rate must be between 0 and 1");
  }
  
  // Validate PII redaction
  if (config.piiRedaction?.enabled && config.piiRedaction?.patterns) {
    for (const pattern of config.piiRedaction.patterns) {
      if (!(pattern instanceof RegExp)) {
        throw new Error("OTel plugin: piiRedaction.patterns must be RegExp instances");
      }
    }
  }

  // Validate persistence
  if (config.persistence?.maxInMemory != null && config.persistence.maxInMemory <= 0) {
    throw new Error("OTel plugin: persistence.maxInMemory must be > 0");
  }
  if (config.persistence?.maxSpans != null && config.persistence.maxSpans <= 0) {
    throw new Error("OTel plugin: persistence.maxSpans must be > 0");
  }
  if (
    config.persistence?.maxInMemory != null &&
    config.persistence?.maxSpans != null &&
    config.persistence.maxSpans < config.persistence.maxInMemory
  ) {
    throw new Error("OTel plugin: persistence.maxSpans must be >= persistence.maxInMemory");
  }

  // Validate disabledMetrics is string array
  if (config.disabledMetrics != null && !Array.isArray(config.disabledMetrics)) {
    throw new Error("OTel plugin: disabledMetrics must be an array of strings");
  }
  if (Array.isArray(config.disabledMetrics)) {
    for (const m of config.disabledMetrics) {
      if (typeof m !== 'string' || m.length === 0) {
        throw new Error("OTel plugin: disabledMetrics entries must be non-empty strings");
      }
    }
  }

  // Validate metricPrefix
  if (config.metricPrefix != null && typeof config.metricPrefix !== 'string') {
    throw new Error("OTel plugin: metricPrefix must be a string");
  }

  // Validate metricsTemporality
  if (config.metricsTemporality != null && config.metricsTemporality !== 'cumulative' && config.metricsTemporality !== 'delta') {
    throw new Error("OTel plugin: metricsTemporality must be 'cumulative' or 'delta'");
  }

  // Validate headersHelper path type
  if (config.headersHelper != null && typeof config.headersHelper !== 'string') {
    throw new Error("OTel plugin: headersHelper must be a string path");
  }

  // Validate traceparent format if provided
  if (config.traceparent != null) {
    if (typeof config.traceparent !== 'string' || !/^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/i.test(config.traceparent)) {
      throw new Error("OTel plugin: traceparent must be a valid W3C traceparent (00-<32hex>-<16hex>-<2hex>)");
    }
  }
}

// ─── Export ───────────────────────────────────────────────────────────────────

export const defaults = {
  DEFAULT_ENDPOINT,
  DEFAULT_PROTOCOL,
  DEFAULT_SERVICE_NAME,
  DEFAULT_ENVIRONMENT,
  DEFAULT_BATCH,
  DEFAULT_SAMPLING,
  DEFAULT_PII_REDACTION,
  DEFAULT_RESOURCE_ATTRIBUTES,
  DEFAULT_HEADERS,
  DEFAULT_DEBUG,
  DEFAULT_PERSISTENCE,
};

export type { OtelPluginOptions };
export type RequiredConfig = { [K in keyof OtelPluginOptions]-?: OtelPluginOptions[K] };
export { mergeConfig, validateConfig };