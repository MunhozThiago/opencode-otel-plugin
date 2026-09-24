/**
 * opencode-otel-plugin - Core Types
 * 
 * Type definitions for the OpenTelemetry plugin.
 */

import type { PluginInput, PluginOptions, Config } from "@opencode-ai/plugin";
import type { Event } from "@opencode-ai/sdk";
import type { Span, SpanContext, SpanKind, Attributes, Context, Sampler, SamplingResult } from "@opentelemetry/api";
import type { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { RequiredConfig } from "./config.js";

// ─── Plugin Configuration ─────────────────────────────────────────────────────

export interface OtelPluginOptions {
  /** OTLP endpoint (HTTP or gRPC) */
  endpoint?: string;
  
  /** Export protocol */
  protocol?: 'http' | 'grpc';
  
  /** Service name for resource attributes */
  serviceName?: string;
  
  /** Service version */
  serviceVersion?: string;
  
  /** Deployment environment */
  environment?: string;
  
  /** Batch export configuration */
  batch?: {
    maxQueueSize?: number;
    maxExportBatchSize?: number;
    scheduledDelayMillis?: number;
    exportTimeoutMillis?: number;
  };
  
  /** Sampling configuration */
  sampling?: {
    /** Sampling rate (0-1), 1 = always sample */
    rate?: number;
    /** Never sample mid-conversation */
    conversationAware?: boolean;
    /** Parent-based sampling */
    parentBased?: boolean;
  };
  
  /** PII redaction */
  piiRedaction?: {
    enabled?: boolean;
    /** Custom regex patterns */
    patterns?: RegExp[];
    /** Fields to always redact */
    defaultFields?: string[];
  };
  
  /** Resource attributes */
  resourceAttributes?: Record<string, string>;
  
  /** Local span persistence (durable buffer if OTLP export fails) */
  persistence?: {
    enabled?: boolean;
    /** Directory for span files (default: ./.opencode-otel/spans) */
    directory?: string;
    /** Max spans held in memory before spill to disk (default: 512) */
    maxInMemory?: number;
    /** Max total persisted spans (default: 10000) */
    maxSpans?: number;
  };
  
  /** Enable debug logging */
  debug?: boolean;

  /** Headers for OTLP endpoint (auth, etc.) */
  headers?: Record<string, string>;

  /** External helper executable that prints refreshed OTLP headers as JSON to stdout */
  headersHelper?: string;

  /** Timeout for headers helper (ms, default 5000) */
  headersHelperTimeoutMs?: number;

  /** Remote parent traceparent (W3C) for startup nesting under external callers */
  traceparent?: string;

  /** Remote parent tracestate */
  tracestate?: string;

  /** Disable specific metric instruments by base name */
  disabledMetrics?: string[];

  /** Disable all traces export */
  disabledTraces?: boolean;

  /** Disable all logs export */
  disabledLogs?: boolean;

  /** Prefix for all metric names (e.g. "myapp.") */
  metricPrefix?: string;

  /** Metrics temporality (cumulative default; delta for some backends e.g. Datadog) */
  metricsTemporality?: 'cumulative' | 'delta';

  /** Additional span attributes applied to every span */
  spanAttributes?: Record<string, string>;

  /** Enable structured log export (default true when logs setup succeeds) */
  logsEnabled?: boolean;

  /** Capture raw prompt content in logs (default false; redacted otherwise) */
  capturePromptInLogs?: boolean;
}

// ─── Internal State ───────────────────────────────────────────────────────────

export interface PluginState {
  provider: NodeTracerProvider;
  processor: SpanProcessor;
  sampler: ConversationSampler;
  config: RequiredConfig;
  activeSpans: Map<string, Span>; // key: sessionId or spanId
  conversationSamplingCache: Map<string, SamplingResult>;
  baggageMap: Map<string, Record<string, string>>; // conversationId -> baggage
}

export interface SpanMetadata {
  sessionId: string;
  agentId: string;
  agentName: string;
  conversationId: string;
  parentSpanId?: string;
  spanType: SpanType;
  startTime: number;
}

// ─── Span Types ───────────────────────────────────────────────────────────────

export type SpanType =
  | 'agent.root'           // Primary agent session
  | 'agent.sub'            // Sub-agent (subtask)
  | 'chat'                 // LLM inference
  | 'tool'                 // Tool execution
  | 'mcp.tool'             // MCP tool execution
  | 'plan'                 // Planning/decision
  | 'delegation'           // Agent handoff
  | 'memory.create'        // Memory creation (context compaction)
  | 'memory.search'        // Memory search
  | 'memory.update'        // Memory update
  | 'memory.delete'        // Memory deletion
  | 'workflow'             // Workflow/orchestration
  | 'session'              // Session lifecycle
  | 'compaction'           // Session compaction
  | 'todo'                 // Todo tracking
  | 'command'              // Command execution
  | 'file';                // File operations

// ─── GenAI Semantic Convention Attributes ────────────────────────────────────

export interface GenAIAttributes {
  // Required
  'gen_ai.agent.id': string;
  'gen_ai.agent.name': string;
  'gen_ai.conversation.id': string;
  'gen_ai.operation.name': string;
  
  // Recommended
  'gen_ai.agent.version'?: string;
  'gen_ai.session.id'?: string;
  'gen_ai.agent.description'?: string;
  'gen_ai.request.model'?: string;
  'gen_ai.response.model'?: string;
  'gen_ai.provider.name'?: string;
  'gen_ai.system'?: string;
  'gen_ai.token_usage.input'?: number;
  'gen_ai.token_usage.output'?: number;
  'gen_ai.token_usage.total'?: number;
  
  // Conditional (MCP)
  'mcp.method.name'?: string;
  'mcp.session.id'?: string;
  'mcp.server.name'?: string;
  
  // Custom multi-agent extensions
  'agent.delegation.rationale'?: string;
  'agent.delegation.from_agent_id'?: string;
  'agent.delegation.to_agent_id'?: string;
  'agent.context.package.tokens_sent'?: number;
  'agent.context.package.tokens_received'?: number;
  'agent.context.package.truncated'?: boolean;
  'agent.context.package.diff'?: string;
  'agent.memory.operation'?: 'create' | 'search' | 'update' | 'delete';
  'agent.memory.key'?: string;
  'agent.memory.version'?: number;
  'agent.context.window.fill_percent'?: number;
  'agent.context.window.tokens_available'?: number;
  'agent.context.window.tokens_used'?: number;
  'agent.context.window.max_tokens'?: number;
  'agent.workflow.pattern'?: string;
  
  // Tool attributes
  'gen_ai.tool.name'?: string;
  'gen_ai.tool.call_id'?: string;
  'gen_ai.tool.input'?: string;
  'gen_ai.tool.output'?: string;
  'gen_ai.tool.error'?: string;
  'gen_ai.tool.duration_ms'?: number;
  
  // Session attributes
  'session.id'?: string;
  'session.title'?: string;
  'session.project_id'?: string;
  'session.directory'?: string;
  'session.parent_id'?: string;
  
  // Error attributes
  'error.type'?: string;
  'error.message'?: string;
  'error.stack'?: string;
  
  // Context fidelity
  'agent.context.fidelity'?: number;
  'agent.context.fidelity.percent'?: number;
  'agent.context.tokens_sent'?: number;
  'agent.context.tokens_received'?: number;
  'agent.context.tokens_dropped'?: number;
  'agent.context.max_tokens'?: number;
  'agent.context.fidelity.alert'?: boolean;
  'agent.context.fidelity.threshold'?: number;
  
  // Allow additional attributes
  [key: string]: string | number | boolean | string[] | number[] | boolean[] | undefined;
}

// ─── Event Types (from opencode SDK) ──────────────────────────────────────────

// Re-export key event types for convenience
export type SessionEvent = Event & { type: 'session.created' | 'session.updated' | 'session.deleted' | 'session.status' | 'session.idle' | 'session.compacted' | 'session.error' };
export type MessageEvent = Event & { type: 'message.updated' | 'message.removed' };
export type MessagePartEvent = Event & { type: 'message.part.updated' | 'message.part.removed' };
export type ToolEvent = Event & { type: 'tool.execute.before' | 'tool.execute.after' };
export type PermissionEvent = Event & { type: 'permission.ask' | 'permission.replied' };
export type TodoEvent = Event & { type: 'todo.updated' };
export type CommandEvent = Event & { type: 'command.executed' };
export type FileEvent = Event & { type: 'file.edited' };
export type MCPToolEvent = Event & { type: 'mcp.tool.call' | 'mcp.tool.result' | 'mcp.tool.error' };
export type MemoryEvent = Event & { type: 'memory.create' | 'memory.search' | 'memory.update' | 'memory.delete' };
export type PlanEvent = Event & { type: 'plan.created' | 'plan.updated' | 'plan.step' | 'plan.completed' | 'plan.failed' };
export type WorkflowEvent = Event & { type: 'workflow.started' | 'workflow.step' | 'workflow.completed' | 'workflow.failed' };

// ─── Helper Types ─────────────────────────────────────────────────────────────

export interface DelegationInfo {
  fromAgentId: string;
  fromAgentName: string;
  toAgentId: string;
  toAgentName: string;
  rationale?: string;
  contextTokensSent?: number;
  contextTokensReceived?: number;
  truncated?: boolean;
}

export interface ContextPackage {
  tokensSent: number;
  tokensReceived: number;
  truncated: boolean;
  diff?: string;
  messages: Array<{ role: string; content: string; tokens: number }>;
}

export interface MemoryOperation {
  operation: 'create' | 'search' | 'update' | 'delete';
  key: string;
  keyHash: string;
  version?: number;
  hit?: boolean;
  size?: number;
}

export interface ConversationContext {
  conversationId: string;
  sessionId: string;
  rootAgentId: string;
  rootAgentName: string;
  agents: Map<string, AgentInfo>;
  workflowPattern?: string;
  samplingDecision?: SamplingResult;
  delegationChain: DelegationInfo[];
}

export interface AgentInfo {
  id: string;
  name: string;
  description?: string;
  model?: string;
  provider?: string;
  version?: string;
  tools: string[];
  parentId?: string;
  span?: Span;
  contextTokens?: number;
  delegationChain?: DelegationInfo[];
}

// ─── Sampling ─────────────────────────────────────────────────────────────────

export interface ConversationSampler extends Sampler {
  getConversationDecision(conversationId: string): SamplingResult | undefined;
  setConversationDecision(conversationId: string, decision: SamplingResult): void;
  clearConversationDecision(conversationId: string): void;
}

// ─── Baggage ──────────────────────────────────────────────────────────────────

export interface BaggageEntries {
  'gen_ai.conversation.id': string;
  'gen_ai.agent.id'?: string;
  'gen_ai.session.id'?: string;
  [key: string]: string | undefined;
}

// ─── PII Redaction ────────────────────────────────────────────────────────────

export type Replacement = string | ((match: string) => string);

export interface RedactionRule {
  pattern: RegExp;
  replacement: string | ((match: string) => string);
  fields?: string[];
}

export interface PIIConfig {
  enabled: boolean;
  patterns: RedactionRule[];
  defaultFields: string[];
}

// ─── Export ───────────────────────────────────────────────────────────────────

export type { Span, SpanContext, SpanKind, Attributes, Context, Sampler, SamplingResult };
export type { PluginInput, PluginOptions, Config, Event };