# opencode-otel-plugin

OpenTelemetry instrumentation for [opencode](https://opencode.ai) — multi-agent observability via OTLP (traces, metrics, logs).

Exports agent lifecycle, tool calls, GenAI token/cost telemetry, delegation/workflow spans, and structured logs to any OTLP collector (SigNoz, Grafana, Datadog, Honeycomb, Jaeger, etc.).

## Features

- **Traces** — GenAI semconv spans plus multi-agent taxonomy (delegation, context packages, plan, todo, memory, MCP, workflow, command, file, compaction)
- **Metrics** — official catalog: `session.count`, `token.usage`, `cost.usage`, `tool.duration`, `lines_of_code.*`, `commit.count`, `cache.count`, `session.duration`, `message.count`, `session.token.total`, `session.cost.total`, `model.usage`, `retry.count`, `subtask.count`
- **Logs** — structured OTLP logs with `event.name` taxonomy (`user_prompt`, `api_request`, `api_error`, `tool_result`, `tool_decision`, `commit`, `session.*`)
- **PII redaction** on by default (patterns + sensitive field rules)
- **Conversation-aware sampling** — no mid-conversation trace splits
- **Local span persistence** — JSONL durable buffer when the collector is down
- **W3C TraceContext + Baggage** propagation for `gen_ai.conversation.id`
- **Dynamic OTLP headers** — helper script + 401/403 refresh-and-retry
- **Lifecycle flush** — forceFlush on session idle/error/message-complete + SIGTERM/SIGINT/beforeExit
- **Kill-switches** — `disabledTraces` / `disabledLogs` / `disabledMetrics`
- **Env config** — `OPENCODE_*` (and `OTEL_*` bridge) layered under explicit options

## Install

```bash
npm install opencode-otel-plugin
```

Or add to `~/.config/opencode/opencode.json`:

```json
{
  "plugin": ["opencode-otel-plugin"]
}
```

## Quick start

```bash
# Local Jaeger (OTLP HTTP)
export OPENCODE_OTEL_ENDPOINT="http://localhost:4318/v1/traces"
export OPENCODE_OTEL_DEBUG=true
opencode
```

```json
// opencode.json
{
  "plugin": ["opencode-otel-plugin"],
  "otel": {
    "endpoint": "http://localhost:4318/v1/traces",
    "serviceName": "my-agent",
    "environment": "dev",
    "sampling": { "rate": 1.0 }
  }
}
```

## Configuration

Precedence: **explicit options > `OPENCODE_*` env > defaults**.

| Option | Env | Default | Notes |
|--------|-----|---------|-------|
| `endpoint` | `OPENCODE_OTEL_ENDPOINT` | `http://localhost:4318/v1/traces` | OTLP endpoint (traces path or base) |
| `protocol` | `OPENCODE_OTEL_PROTOCOL` | `http` | `http` \| `grpc` \| `http/protobuf` \| `http/json` |
| `serviceName` | `OPENCODE_OTEL_SERVICE_NAME` | `opencode` | Resource `service.name` |
| `serviceVersion` | `OPENCODE_OTEL_SERVICE_VERSION` | `1.0.0` | |
| `environment` | `OPENCODE_OTEL_ENVIRONMENT` | `development` | |
| `headers` | `OPENCODE_OTEL_HEADERS` | `{}` | `k=v,k2=v2` (CR/LF rejected) |
| `headersHelper` | `OPENCODE_OTEL_HEADERS_HELPER` | — | Executable path; stdout JSON `{"Authorization":"Bearer …"}` |
| `headersHelperTimeoutMs` | `OPENCODE_OTEL_HEADERS_HELPER_TIMEOUT_MS` | `5000` | |
| `traceparent` | `OPENCODE_TRACEPARENT` | — | Remote parent (W3C) |
| `tracestate` | `OPENCODE_TRACESTATE` | — | |
| `sampling.rate` | `OPENCODE_OTEL_SAMPLING_RATE` | `1.0` | 0–1 |
| `sampling.conversationAware` | `OPENCODE_OTEL_CONVERSATION_SAMPLING` | `true` | |
| `sampling.parentBased` | `OPENCODE_OTEL_PARENT_BASED` | `true` | |
| `batch.maxQueueSize` | `OPENCODE_OTEL_MAX_QUEUE_SIZE` | `2048` | |
| `batch.maxExportBatchSize` | `OPENCODE_OTEL_MAX_EXPORT_BATCH` | `512` | ≤ maxQueueSize |
| `batch.scheduledDelayMillis` | `OPENCODE_OTEL_SCHEDULED_DELAY_MS` | `5000` | |
| `batch.exportTimeoutMillis` | `OPENCODE_OTEL_EXPORT_TIMEOUT_MS` | `30000` | |
| `piiRedaction.enabled` | `OPENCODE_OTEL_PII_REDACTION` | `true` | |
| `persistence.enabled` | `OPENCODE_OTEL_PERSISTENCE` | `false` | Local JSONL span buffer |
| `persistence.directory` | `OPENCODE_OTEL_PERSISTENCE_DIR` | — | |
| `resourceAttributes.*` | `OPENCODE_OTEL_RESOURCE_ATTRS` | `{}` | `k=v,k2=v2` |
| `spanAttributes.*` | `OPENCODE_OTEL_SPAN_ATTRS` | `{}` | Applied to every span |
| `metricPrefix` | `OPENCODE_OTEL_METRIC_PREFIX` | `""` | e.g. `myapp.` |
| `metricsTemporality` | `OPENCODE_OTEL_METRICS_TEMPORALITY` | `cumulative` | `delta` for Datadog |
| `disabledMetrics` | `OPENCODE_OTEL_DISABLED_METRICS` | `[]` | Base instrument names |
| `disabledTraces` | `OPENCODE_OTEL_DISABLED_TRACES` | `false` | Kill-switch |
| `disabledLogs` | `OPENCODE_OTEL_DISABLED_LOGS` | `false` | Kill-switch |
| `logsEnabled` | `OPENCODE_OTEL_LOGS_ENABLED` | `true` | |
| `capturePromptInLogs` | `OPENCODE_OTEL_CAPTURE_PROMPT` | `false` | Off → prompts redacted |
| `debug` | `OPENCODE_OTEL_DEBUG` | `false` | |

### OTEL bridge

Also honors standard env when set: `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY`.

### Dynamic auth headers

```bash
export OPENCODE_OTEL_HEADERS_HELPER="/usr/local/bin/otlp-token"
```

Helper must print JSON headers on stdout. On HTTP 401/403 or gRPC UNAUTHENTICATED/PERMISSION_DENIED, the plugin refreshes headers and retries the export once.

### Remote parent (CI / LLM gateway)

```bash
export OPENCODE_TRACEPARENT="00-<trace-id>-<span-id>-01"
```

Root spans continue that trace; `chat.headers` injects the live LLM span `traceparent` for allowlisted providers.

## Collector recipes

### Jaeger (local)

```bash
docker run -d --name jaeger -e COLLECTOR_OTLP_ENABLED=true \
  -p 16686:16686 -p 4318:4318 jaegertracing/all-in-one:latest
export OPENCODE_OTEL_ENDPOINT="http://localhost:4318/v1/traces"
```

### Grafana Tempo / LGTM

```bash
export OPENCODE_OTEL_ENDPOINT="http://localhost:4318/v1/traces"
```

### SigNoz

```bash
export OPENCODE_OTEL_ENDPOINT="https://ingest.<region>.signoz.cloud/v1/traces"
export OPENCODE_OTEL_HEADERS="signoz-ingestion-key=<your-key>"
```

### Datadog

```bash
export OPENCODE_OTEL_ENDPOINT="http://localhost:4318/v1/traces"
export OPENCODE_OTEL_METRICS_TEMPORALITY="delta"
export OPENCODE_OTEL_HEADERS="dd-api-key=<your-key>"
```

### Honeycomb

```bash
export OPENCODE_OTEL_ENDPOINT="https://api.honey.io/v1/traces"
export OPENCODE_OTEL_HEADERS="x-honeycomb-team=<your-key>"
```

## Metrics catalog

| Instrument | Type | Emitted on |
|------------|------|------------|
| `session.count` | counter | session.created |
| `session.duration` | histogram | session idle/complete |
| `session.token.total` | histogram | session idle |
| `session.cost.total` | histogram | session idle |
| `token.usage` | counter | token usage events |
| `cost.usage` | counter | cost events |
| `message.count` | counter | assistant messages |
| `model.usage` | counter | model messages |
| `tool.duration` | histogram | tool.execute |
| `lines_of_code.count` / `.total` | counter | file.edited |
| `commit.count` | counter | git commit |
| `cache.count` | counter | cache hit/miss |
| `retry.count` | counter | retries |
| `subtask.count` | counter | delegation |
| `gen_ai.client.*` | counter/histogram | GenAI operations |

Prefix all with `metricPrefix` when set; omit via `disabledMetrics`.

## Log events

`event.name` ∈ `session.created` | `session.idle` | `session.error` | `user_prompt` | `api_request` | `api_error` | `tool_result` | `tool_decision` | `commit`.

Prompt content is redacted unless `capturePromptInLogs: true`.

## Multi-agent spans

| Span / event | Meaning |
|--------------|---------|
| `agent.delegation` | Handoff + rationale |
| `agent.context_package` | Context transferred at handoff |
| `plan.*` | Planning steps |
| `todo.*` | Task board updates |
| `memory.*` | Create/search/update/delete |
| `mcp.*` | MCP tool calls |
| `workflow.*` | Orchestration |
| `command.*` | Shell / git commands |
| `file.*` | File edits |
| `session.compacting` | Context compaction |

## Programmatic API

```ts
import plugin, { forceFlush, getTracer, isPluginActive } from "opencode-otel-plugin";

const hooks = await plugin(input, { endpoint: "http://localhost:4318/v1/traces" });
// …
await forceFlush();
```

## Development

```bash
npm install
npm run build
npm test
npm audit
```

Tests import compiled output from `dist/` — always run `npm run build` after editing `src/`.

## Requirements

- Node.js ≥ 20
- peer: `@opencode-ai/plugin` / `@opencode-ai/sdk` ^1.18.0

## License

MIT
