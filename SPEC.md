# opencode-otel-plugin Specification

**Version:** 1.0.0  
**Status:** Draft  
**Based on:** MULTI_AGENT_OBSERVABILITY_FEATURE_PLAN.md  

---

## 1. Overview

The `opencode-otel-plugin` is an OpenTelemetry instrumentation plugin for opencode that captures all agent execution events and exports them as OTLP (OpenTelemetry Protocol) spans to a control plane. It implements the **OpenTelemetry GenAI Semantic Conventions v1.40+** with multi-agent extensions for conversation correlation, delegation tracking, context fidelity, and memory observability.

### 1.1 Purpose

Enable opencode to send **complete observability data** to the control plane including:
- Agent lifecycle (start, end, error)
- Tool calls (including MCP tools)
- Model inferences (LLM calls with token usage)
- Agent-to-agent handoffs (delegation)
- Planning and decision events
- Memory operations (create, search, update, delete)
- Context window snapshots at handoff boundaries
- Workflow/orchestration spans

### 1.2 Scope

**In Scope:**
- OTLP/HTTP and OTLP/gRPC export
- GenAI Semantic Conventions v1.40+ span kinds and attributes
- Custom multi-agent extensions (delegation rationale, context packages, memory ops)
- W3C TraceContext + Baggage propagation for `gen_ai.conversation.id`
- Non-blocking batch export with local buffering
- PII redaction at ingest
- Conversation-aware sampling (all-or-nothing per conversation)
- Framework-agnostic manual SDK (`@observe` decorator pattern)

**Out of Scope:**
- UI/visualization (handled by control plane)
- Evaluation/guardrails runtime (handled by control plane)
- Replay engine (handled by control plane)
- Multi-tenant auth (host project responsibility)

---

## 2. Architecture

### 2.1 High-Level Data Flow

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐     ┌──────────────┐
│   opencode      │────▶│  opencode-otel   │────▶│  OTLP Exporter  │────▶│ Control Plane│
│   (events)      │     │  Plugin          │     │  (Batch/HTTP)   │     │  (Ingest)    │
└─────────────────┘     └──────────────────┘     └─────────────────┘     └──────────────┘
                              │
                              ▼
                     ┌──────────────────┐
                     │  OpenTelemetry   │
                     │  SDK + GenAI     │
                     │  Conventions     │
                     └──────────────────┘
```

### 2.2 Plugin Hooks Used

| Hook | Events Captured | Span Kind |
|------|-----------------|-----------|
| `event` | Session lifecycle, message updates, tool calls, permissions | `invoke_agent`, `execute_tool`, `chat` |
| `chat.message` | User/assistant messages | `chat` |
| `chat.params` | Model parameters | `chat` (attributes) |
| `tool.execute.before/after` | Tool calls | `execute_tool` |
| `experimental.session.compacting` | Context compaction | `create_memory` / internal |
| `permission.ask` | Permission prompts | `execute_tool` (blocked) |

### 2.3 Span Kinds Mapping (GenAI Semantic Conventions v1.40+)

| opencode Event | OTel Span Kind | `gen_ai.operation.name` |
|----------------|----------------|------------------------|
| Session start (primary agent) | `invoke_agent` | `invoke_agent` |
| Sub-agent spawn (subtask) | `invoke_agent` | `invoke_agent` |
| Agent message (LLM call) | `chat` | `chat` |
| Tool call (built-in) | `execute_tool` | `execute_tool` |
| MCP tool call | `execute_tool` | `execute_tool` + `mcp.*` |
| Planning/decision | `plan` | `plan` |
| Handoff/delegation | `invoke_agent` | `invoke_agent` + `agent.delegation.*` |
| Memory ops (context compaction) | `create_memory`/`search_memory` | `create_memory`/`search_memory` |
| Session compaction | `create_memory` | `create_memory` |

---

## 3. Data Model

### 3.1 Required Attributes (Non-Negotiable)

| Attribute | Type | Source | Description |
|-----------|------|--------|-------------|
| `gen_ai.agent.id` | string | Agent name + session | Stable identity across sessions |
| `gen_ai.agent.name` | string | Agent config | Human-readable for swim lanes |
| `gen_ai.agent.version` | string | Agent config hash | Track agent code changes |
| `gen_ai.conversation.id` | string | Session ID | **Primary correlation key** |
| `gen_ai.session.id` | string | Session ID | Broader user journey |
| `gen_ai.agent.description` | string | Agent config.description | Delegation rationale capture |
| `gen_ai.request.model` | string | Model config | Model drift detection |
| `gen_ai.response.model` | string | Actual model used | Model drift detection |
| `gen_ai.token_usage.input` | int | AssistantMessage.tokens.input | Cost governance |
| `gen_ai.token_usage.output` | int | AssistantMessage.tokens.output | Cost governance |
| `gen_ai.token_usage.total` | int | Sum | Cost governance |
| `gen_ai.operation.name` | string | Span kind mapping | Standard operation name |

### 3.2 Conditional Attributes

| Attribute | Condition | Source |
|-----------|-----------|--------|
| `mcp.method.name` | MCP tool calls | Tool name prefix |
| `mcp.session.id` | MCP session | MCP connection |
| `gen_ai.provider.name` | All LLM spans | Provider config |
| `gen_ai.system` | All LLM spans | Provider (openai, anthropic, etc.) |

### 3.3 Custom Multi-Agent Extensions

| Attribute | Type | Description |
|-----------|------|-------------|
| `agent.delegation.rationale` | string | Why this agent was chosen (from agent description, task prompt) |
| `agent.delegation.from_agent_id` | string | Delegating agent ID |
| `agent.delegation.to_agent_id` | string | Target agent ID |
| `agent.context.package.tokens_sent` | int | Tokens in context package at handoff |
| `agent.context.package.tokens_received` | int | Tokens received by sub-agent |
| `agent.context.package.truncated` | boolean | Whether context was truncated |
| `agent.context.package.diff` | string | JSON diff of sent vs received |
| `agent.memory.operation` | string | `create` \| `search` \| `update` \| `delete` |
| `agent.memory.key` | string | Memory key (hashed for PII) |
| `agent.memory.version` | int | Version vector for drift detection |
| `agent.context.window.fill_percent` | float | Context window utilization % |
| `agent.context.window.tokens_available` | int | Remaining tokens |
| `agent.workflow.pattern` | string | sequential, concurrent, handoff, hierarchical, etc. |

### 3.4 Span Events

| Event Name | Attributes | When |
|------------|------------|------|
| `agent.handoff` | `from_agent`, `to_agent`, `rationale`, `context_tokens` | Delegation |
| `context.compacted` | `tokens_before`, `tokens_after`, `summary` | Session compaction |
| `tool.blocked` | `tool_name`, `reason` | Permission denied |
| `memory.access` | `operation`, `key_hash`, `hit` | Memory ops |

---

## 4. Configuration

### 4.1 Plugin Options

```typescript
interface OtelPluginOptions {
  /** OTLP endpoint (HTTP or gRPC) */
  endpoint?: string; // default: "http://localhost:4318/v1/traces"
  
  /** Export protocol */
  protocol?: 'http' | 'grpc'; // default: 'http'
  
  /** Service name for resource attributes */
  serviceName?: string; // default: 'opencode'
  
  /** Service version */
  serviceVersion?: string; // default: opencode version
  
  /** Deployment environment */
  environment?: string; // default: 'development'
  
  /** Batch export configuration */
  batch?: {
    maxQueueSize?: number; // default: 2048
    maxExportBatchSize?: number; // default: 512
    scheduledDelayMillis?: number; // default: 5000
    exportTimeoutMillis?: number; // default: 30000
  };
  
  /** Sampling configuration */
  sampling?: {
    /** Sampling rate (0-1), 1 = always sample */
    rate?: number; // default: 1.0
    /** Never sample mid-conversation */
    conversationAware?: boolean; // default: true
    /** Parent-based sampling */
    parentBased?: boolean; // default: true
  };
  
  /** PII redaction */
  piiRedaction?: {
    enabled?: boolean; // default: true
    /** Custom regex patterns */
    patterns?: RegExp[];
    /** Fields to always redact */
    fields?: string[]; // default: ['apiKey', 'password', 'secret', 'token']
  };
  
  /** Resource attributes */
  resourceAttributes?: Record<string, string>;
  
  /** Enable debug logging */
  debug?: boolean; // default: false
  
  /** Headers for OTLP endpoint (auth, etc.) */
  headers?: Record<string, string>;
}
```

### 4.2 Example opencode.json Configuration

```json
{
  "plugin": [
    ["opencode-otel-plugin", {
      "endpoint": "http://localhost:4318/v1/traces",
      "protocol": "http",
      "serviceName": "my-opencode-agent",
      "environment": "production",
      "batch": {
        "maxExportBatchSize": 512,
        "scheduledDelayMillis": 5000
      },
      "sampling": {
        "rate": 1.0,
        "conversationAware": true
      },
      "piiRedaction": {
        "enabled": true,
        "fields": ["apiKey", "password", "secret", "token", "authorization"]
      },
      "resourceAttributes": {
        "deployment.environment": "production",
        "team": "platform"
      }
    }]
  ]
}
```

---

## 5. Implementation Requirements

### 5.1 OpenTelemetry SDK Setup

- Use `@opentelemetry/sdk-node` (not `@opentelemetry/sdk-trace-node` - deprecated)
- Configure `NodeTracerProvider` with:
  - `BatchSpanProcessor` for non-blocking export
  - `Resource` with service.name, service.version, deployment.environment
  - Custom `Sampler` for conversation-aware sampling
- Register GenAI semantic conventions via `@opentelemetry/semantic-conventions` v1.30+

### 5.2 OTLP Exporter

- Support both HTTP (`@opentelemetry/exporter-trace-otlp-http`) and gRPC (`@opentelemetry/exporter-trace-otlp-grpc`)
- Configure based on `protocol` option
- Handle authentication via headers
- Graceful shutdown on plugin dispose

### 5.3 Conversation-Aware Sampling

```typescript
class ConversationAwareSampler implements Sampler {
  shouldSample(context: Context, traceId: string, spanName: string, spanKind: SpanKind, attributes: Attributes, links: Link[]): SamplingResult {
    // Extract conversation.id from baggage or attributes
    const conversationId = getConversationId(context, attributes);
    
    if (!conversationId) {
      // No conversation ID - sample based on rate
      return rateBasedSample();
    }
    
    // Check if we've already made a sampling decision for this conversation
    const decision = conversationSamplingCache.get(conversationId);
    if (decision) return decision;
    
    // Make new decision
    const result = rateBasedSample();
    conversationSamplingCache.set(conversationId, result);
    return result;
  }
}
```

### 5.4 W3C TraceContext + Baggage Propagation

- Inject `traceparent` and `baggage` headers on outbound MCP/A2A calls
- Extract on inbound (if opencode receives delegations)
- Baggage keys: `gen_ai.conversation.id`, `gen_ai.agent.id`, `gen_ai.session.id`

### 5.5 PII Redaction

- Redact before span export (in `SpanProcessor.onEnd`)
- Default patterns: API keys, passwords, secrets, tokens, authorization headers
- Configurable custom regex patterns
- Hash memory keys instead of storing plaintext

### 5.6 Non-Blocking Export

- Use `BatchSpanProcessor` with configurable queue/batch sizes
- Implement `onShutdown` to flush pending spans
- Never block agent execution on export

---

## 6. Event-to-Span Mapping

### 6.1 Session Lifecycle

| Event | Span | Attributes |
|-------|------|------------|
| `session.created` | `invoke_agent` (root) | `gen_ai.conversation.id`, `gen_ai.agent.id`, `gen_ai.agent.name`, `agent.workflow.pattern` |
| `session.updated` | - | Update session metadata |
| `session.deleted` | End root span | `session.end_time`, `session.duration` |
| `session.compacted` | `create_memory` | `agent.memory.operation=create`, `agent.context.window.tokens_before/after` |
| `session.error` | End root span with error | `error.type`, `error.message`, `gen_ai.agent.error` |

### 6.2 Message Events

| Event | Span | Attributes |
|-------|------|------------|
| `message.updated` (user) | - | Add to context package |
| `message.updated` (assistant) | `chat` | `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.token_usage.*`, `gen_ai.operation.name=chat`, `gen_ai.prompt.*` |
| `message.part.updated` (tool) | `execute_tool` | `gen_ai.tool.name`, `gen_ai.tool.call_id`, `tool.input`, `tool.output` |
| `message.part.updated` (agent/subtask) | `invoke_agent` | `agent.delegation.*`, `gen_ai.agent.id` (sub-agent) |

### 6.3 Tool Events

| Event | Span | Attributes |
|-------|------|------------|
| `tool.execute.before` | Start `execute_tool` | `gen_ai.tool.name`, `gen_ai.tool.call_id`, `tool.input` |
| `tool.execute.after` | End `execute_tool` | `tool.output`, `tool.duration`, `tool.error` (if any) |
| `permission.ask` (denied) | `execute_tool` (error) | `tool.blocked=true`, `tool.block_reason` |

### 6.4 MCP Events

- Detect MCP tools by name prefix (`mcp__` or config)
- Add `mcp.method.name`, `mcp.server.name`, `mcp.session.id`
- Trace MCP server connection lifecycle

### 6.5 Handoff/Delegation Detection

- Detect `subtask` parts in assistant messages
- Create `invoke_agent` span for sub-agent with:
  - `agent.delegation.rationale` from subtask description
  - `agent.delegation.from_agent_id` = parent agent
  - `agent.delegation.to_agent_id` = sub-agent name
  - `agent.context.package.*` from context window snapshot

---

## 7. Testing Requirements

### 7.1 Unit Tests

- Span attribute mapping for each event type
- PII redaction patterns
- Sampling decision logic
- Baggage propagation
- Custom attribute generation

### 7.2 Integration Tests

- Full event flow: opencode event → OTel span → OTLP export
- Conversation correlation across multiple agents
- MCP tool tracing
- Session compaction as memory operation
- Graceful shutdown flushes spans

### 7.3 Contract Tests

- OTLP payload conforms to GenAI semantic conventions
- Required attributes present on all spans
- Custom extensions valid

---

## 8. Success Criteria

| Metric | Target |
|--------|--------|
| Span export latency (p99) | < 100ms |
| Memory overhead | < 50MB |
| CPU overhead | < 5% |
| Zero data loss on graceful shutdown | 100% |
| Conversation correlation accuracy | 100% |
| Required attributes coverage | 100% |
| PII redaction effectiveness | 100% (no false negatives) |

---

## 9. File Structure

```
opencode-otel-plugin/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── SPEC.md
├── src/
│   ├── index.ts                    # Plugin entry point
│   ├── config.ts                   # Configuration schema & defaults
│   ├── otel/
│   │   ├── provider.ts             # OTel SDK setup
│   │   ├── exporter.ts             # OTLP exporter config
│   │   ├── sampler.ts              # Conversation-aware sampler
│   │   ├── processor.ts            # Custom span processor (PII, enrichment)
│   │   ├── baggage.ts              # W3C baggage propagation
│   │   └── semantic-conventions.ts # GenAI attribute helpers
│   ├── hooks/
│   │   ├── event.ts                # Session/message/tool event handler
│   │   ├── chat.ts                 # chat.message, chat.params hooks
│   │   ├── tool.ts                 # tool.execute.before/after hooks
│   │   └── session.ts              # session.compacting, permission hooks
│   ├── mappers/
│   │   ├── session.ts              # Session events → spans
│   │   ├── message.ts              # Message events → spans
│   │   ├── tool.ts                 # Tool events → spans
│   │   └── delegation.ts           # Handoff detection → spans
│   ├── utils/
│   │   ├── pii.ts                  # PII redaction
│   │   ├── context.ts              # Context window snapshots
│   │   ├── ids.ts                  # Stable ID generation
│   │   └── hash.ts                 # Memory key hashing
│   └── types.ts                    # Plugin-specific types
└── tests/
    ├── unit/
    │   ├── mappers.test.ts
    │   ├── pii.test.ts
    │   ├── sampler.test.ts
    │   └── baggage.test.ts
    └── integration/
        └── e2e.test.ts
```

---

## 10. Dependencies

### 10.1 Production

```json
{
  "@opentelemetry/api": "^1.9.0",
  "@opentelemetry/sdk-node": "^0.56.0",
  "@opentelemetry/sdk-trace-base": "^1.30.0",
  "@opentelemetry/exporter-trace-otlp-http": "^0.56.0",
  "@opentelemetry/exporter-trace-otlp-grpc": "^0.56.0",
  "@opentelemetry/resources": "^1.30.0",
  "@opentelemetry/semantic-conventions": "^1.30.0",
  "@opentelemetry/context-async-hooks": "^1.30.0",
  "@opencode-ai/plugin": "^1.18.0",
  "@opencode-ai/sdk": "^1.18.0"
}
```

### 10.2 Development

```json
{
  "typescript": "^5.6.0",
  "vitest": "^2.1.0",
  "@types/node": "^22.0.0",
  "eslint": "^9.0.0",
  "prettier": "^3.3.0"
}
```

---

## 11. Future Extensions

**Shipped (moved out of Future):**
1. **Metrics Export** — `PeriodicExportingMetricReader` + official 15-instrument catalog (`src/otel/metrics.ts`)
2. **Logs Export** — OTLP structured logs with `event.name` taxonomy (`src/otel/logs.ts`)
3. Dynamic OTLP headers + auth retry, `OPENCODE_*` env config, lifecycle forceFlush, signal handlers, remote parent, endpoint probe, bounded maps, kill-switches, README + npm publish path

**Still future:**
4. **Auto-instrumentation** — Detect and instrument MCP servers automatically
5. **A2A Protocol** — Native A2A message tracing when opencode supports A2A
6. **Replay Integration** — Capture full execution state for deterministic replay