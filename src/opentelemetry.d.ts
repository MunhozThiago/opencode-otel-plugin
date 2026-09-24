// Type declarations for OpenTelemetry modules
declare module '@opentelemetry/api' {
  export interface Span {
    name: string;
    spanContext(): SpanContext;
    setAttribute(key: string, value: string | number | boolean | string[] | number[] | boolean[]): this;
    addEvent(name: string, attributes?: Record<string, unknown>): this;
    end(time?: number): void;
  }

  export interface SpanContext {
    traceId: string;
    spanId: string;
    traceFlags: number;
    isRemote?: boolean;
  }

  export interface Attributes {
    [key: string]: string | number | boolean | string[] | number[] | boolean[] | undefined;
  }

  export interface Context {
    // Context is opaque
  }

  export interface Sampler {
    shouldSample(
      context: Context,
      traceId: string,
      spanName: string,
      spanKind: SpanKind,
      attributes: Attributes,
      links: ReadonlyArray<{ context: Context; attributes?: Attributes }>
    ): SamplingResult;
  }

  export interface SamplingResult {
    decision: SamplingDecision;
    attributes?: Attributes;
  }

  export enum SamplingDecision {
    DROP = 0,
    RECORD = 1,
    RECORD_AND_SAMPLE = 2,
  }

  export enum SpanKind {
    INTERNAL = 0,
    SERVER = 1,
    CLIENT = 2,
    PRODUCER = 3,
    CONSUMER = 4,
  }

  export const trace: {
    getTracer(name: string, version?: string): Tracer;
    getSpan(context: Context): Span | undefined;
    getSpanContext(context: Context): SpanContext | undefined;
    setSpan(context: Context, span: Span): Context;
    setGlobalTracerProvider(provider: TracerProvider): void;
  };

  export const context: {
    active(): Context;
    getValue(context: Context, key: string): unknown;
    setValue(context: Context, key: string, value: unknown): Context;
    with<T>(context: Context, fn: () => T): T;
  };

  export const propagation: {
    setGlobalPropagator(propagator: TextMapPropagator): void;
    TextMapPropagator: {
      inject(context: Context, carrier: unknown, setter: TextMapSetter): void;
      extract(context: Context, carrier: unknown, getter: TextMapGetter): Context;
      fields(): string[];
    };
    TextMapSetter: {
      set(carrier: unknown, key: string, value: string): void;
    };
    TextMapGetter: {
      get(carrier: unknown, key: string): string | undefined;
    };
  };

  export interface TextMapPropagator {
    inject(context: Context, carrier: unknown, setter: TextMapSetter): void;
    extract(context: Context, carrier: unknown, getter: TextMapGetter): Context;
    fields(): string[];
  }

  export interface TextMapSetter {
    set(carrier: unknown, key: string, value: string): void;
  }

  export interface TextMapGetter {
    get(carrier: unknown, key: string): string | undefined;
  }

  export interface Tracer {
    startSpan(name: string, options?: SpanOptions): Span;
  }

  export interface SpanOptions {
    kind?: SpanKind;
    attributes?: Attributes;
    startTime?: number;
  }

  export interface TracerProvider {
    getTracer(name: string, version?: string): Tracer;
    getSampler?(): Sampler;
  }
  
  export const ROOT_CONTEXT: Context;
}

declare module '@opentelemetry/sdk-trace-node' {
  import { Span, SpanContext, Attributes, SpanKind, Context } from '@opentelemetry/api';

  export class NodeTracerProvider {
    constructor(config?: NodeTracerProviderConfig);
    getTracer(name: string, version?: string): Tracer;
    forceFlush(): Promise<void>;
    shutdown(): Promise<void>;
    register(config?: unknown): void;
  }

  export interface NodeTracerProviderConfig {
    resource?: unknown;
    sampler?: Sampler;
    spanLimits?: SpanLimits;
    spanProcessors?: SpanProcessor[];
  }

  export interface SpanLimits {
    attributeCountLimit?: number;
    attributeValueLengthLimit?: number;
    eventCountLimit?: number;
    linkCountLimit?: number;
  }

  export class BatchSpanProcessor implements SpanProcessor {
    constructor(exporter: SpanExporter, config?: BatchSpanProcessorConfig);
  }

  export interface BatchSpanProcessorConfig {
    maxQueueSize?: number;
    maxExportBatchSize?: number;
    scheduledDelayMillis?: number;
    exportTimeoutMillis?: number;
  }
}

declare module '@opentelemetry/sdk-trace-base' {
  import { SpanContext, Attributes, Span, Context } from '@opentelemetry/api';
  
  export interface ReadableSpan {
    name: string;
    spanContext(): SpanContext;
    attributes: Attributes;
    end(time?: number): void;
  }

  export interface SpanProcessor {
    onStart(span: Span, parentContext: SpanContext): void;
    onEnd(span: ReadableSpan): void;
    shutdown(): Promise<void>;
    forceFlush(): Promise<void>;
  }

  export interface SpanExporter {
    export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void;
    shutdown(): Promise<void>;
    forceFlush(): Promise<void>;
  }

  export interface ExportResult {
    code: ExportResultCode;
    error?: Error;
  }

  export enum ExportResultCode {
    SUCCESS = 0,
    FAILED = 1,
  }
}

declare module '@opentelemetry/resources' {
  export interface Resource {
    attributes: Record<string, string | number | boolean>;
    asyncAttributes(): Promise<Record<string, string | number | boolean>>;
    merged(other?: Resource): Resource;
  }
  export function resourceFromAttributes(
    attributes: Record<string, string | number | boolean>,
    options?: unknown,
  ): Resource;
  export function defaultResource(): Resource;
  export function emptyResource(): Resource;
}

declare module '@opentelemetry/semantic-conventions' {
  export const ATTR_SERVICE_NAME: 'service.name';
  export const ATTR_SERVICE_VERSION: 'service.version';
  export const ATTR_DEPLOYMENT_ENVIRONMENT_NAME: 'deployment.environment';
  export const ATTR_TELEMETRY_SDK_LANGUAGE: 'telemetry.sdk.language';
  export const ATTR_TELEMETRY_SDK_NAME: 'telemetry.sdk.name';
  export const ATTR_TELEMETRY_SDK_VERSION: 'telemetry.sdk.version';
}

declare module '@opentelemetry/exporter-trace-otlp-http' {
  export interface OTLPExporterNodeConfigBase {
    url?: string;
    headers?: Record<string, string>;
    timeout?: number;
  }

  export class OTLPTraceExporter {
    constructor(config: OTLPExporterNodeConfigBase);
    export(spans: any[], resultCallback: (result: any) => void): void;
    shutdown(): Promise<void>;
    forceFlush(): Promise<void>;
  }
}

declare module '@opentelemetry/exporter-trace-otlp-grpc' {
  export interface OTLPGRPCExporterConfigNode {
    url?: string;
    headers?: Record<string, string>;
    timeout?: number;
  }

  export class OTLPTraceExporter {
    constructor(config: OTLPGRPCExporterConfigNode);
    export(spans: any[], resultCallback: (result: any) => void): void;
    shutdown(): Promise<void>;
    forceFlush(): Promise<void>;
  }
}

declare module '@opentelemetry/context-async-hooks' {
  export class AsyncHooksContextManager {
    enable(): void;
    disable(): void;
  }
}

declare module '@opentelemetry/sdk-metrics' {
  export class MeterProvider {
    constructor(config?: { resource?: any; readers?: any[] });
    getMeter(name: string, version?: string): Meter;
    addMetricReader(reader: any): void;
    shutdown(): Promise<void>;
    forceFlush(): Promise<void>;
  }

  export class PeriodicExportingMetricReader {
    constructor(config: {
      exporter: any;
      exportIntervalMillis?: number;
      exportTimeoutMillis?: number;
    });
  }

  export interface Meter {
    createCounter(name: string, options?: { description?: string; unit?: string }): Counter;
    createHistogram(name: string, options?: { description?: string; unit?: string }): Histogram;
    createUpDownCounter(name: string, options?: { description?: string; unit?: string }): Counter;
    createObservableGauge(name: string, options?: { description?: string; unit?: string }): any;
  }

  export interface Counter {
    add(value: number, attributes?: Record<string, string | number | boolean>): void;
  }

  export interface Histogram {
    record(value: number, attributes?: Record<string, string | number | boolean>): void;
  }
}

declare module '@opentelemetry/sdk-logs' {
  export class LoggerProvider {
    constructor(config?: { resource?: any; processors?: any[]; forceFlushTimeoutMillis?: number });
    getLogger(name: string, version?: string): Logger;
    shutdown(): Promise<void>;
    forceFlush(): Promise<void>;
  }

  export class BatchLogRecordProcessor {
    constructor(options: {
      exporter: any;
      maxQueueSize?: number;
      maxExportBatchSize?: number;
      scheduledDelayMillis?: number;
      exportTimeoutMillis?: number;
    });
  }

  export interface Logger {
    emit(record: {
      severityNumber?: number;
      severityText?: string;
      body?: string;
      attributes?: Record<string, string | number | boolean>;
      context?: any;
    }): void;
  }
}

declare module '@opentelemetry/exporter-metrics-otlp-http' {
  export class OTLPMetricExporter {
    constructor(config?: { url?: string; headers?: Record<string, string>; timeout?: number });
    export(metrics: any[], resultCallback: (result: any) => void): void;
    shutdown(): Promise<void>;
    forceFlush(): Promise<void>;
  }
}

declare module '@opentelemetry/exporter-metrics-otlp-grpc' {
  export class OTLPMetricExporter {
    constructor(config?: { url?: string; headers?: Record<string, string>; timeout?: number });
    export(metrics: any[], resultCallback: (result: any) => void): void;
    shutdown(): Promise<void>;
    forceFlush(): Promise<void>;
  }
}

declare module '@opentelemetry/exporter-logs-otlp-http' {
  export class OTLPLogExporter {
    constructor(config?: { url?: string; headers?: Record<string, string>; timeout?: number });
    export(records: any[], resultCallback: (result: any) => void): void;
    shutdown(): Promise<void>;
    forceFlush(): Promise<void>;
  }
}

declare module '@opentelemetry/exporter-logs-otlp-grpc' {
  export class OTLPLogExporter {
    constructor(config?: { url?: string; headers?: Record<string, string>; timeout?: number });
    export(records: any[], resultCallback: (result: any) => void): void;
    shutdown(): Promise<void>;
    forceFlush(): Promise<void>;
  }
}