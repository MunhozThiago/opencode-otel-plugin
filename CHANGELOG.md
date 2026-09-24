# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-09-24

### Added

#### Telemetry
- Official 15-instrument metric catalog (`session.count`, `token.usage`, `cost.usage`, `tool.duration`, `lines_of_code.*`, `commit.count`, `cache.count`, `session.duration`, `message.count`, `session.token.total`, `session.cost.total`, `model.usage`, `retry.count`, `subtask.count`)
- Structured OTLP logs with `event.name` taxonomy (`user_prompt`, `api_request`, `api_error`, `tool_result`, `tool_decision`, `commit`, `session.*`)
- OpenInference dual attributes on chat and tool spans (Arize/Phoenix interop)
- Session idle/error lifecycle flush with duration + token total histograms
- LOC, commit, tool.duration, cache, retry, model.usage, message, cost metric emission

#### Config & ops
- `OPENCODE_*` env config layer with precedence: options > env > defaults
- OTEL_* bridge (`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, etc.)
- Protocols: `http`, `grpc`, `http/protobuf`, `http/json`
- Kill-switches: `disabledTraces`, `disabledLogs`, `disabledMetrics`
- `metricPrefix`, `metricsTemporality` (Datadog delta), `spanAttributes`, `logsEnabled`, `capturePromptInLogs`
- Dynamic OTLP headers helper + 401/403 auth refresh-and-retry
- Remote parent context (`traceparent` / `tracestate`)
- Endpoint probe (warn-but-continue) before SDK init
- Bounded maps (`MAX_PENDING=500`) with FIFO eviction and orphan span sweep
- Per-hook `safe()` barrier so telemetry failures never break the host
- Process signal handlers (SIGTERM/SIGINT/beforeExit) with forceFlush
- Unified resource attributes: `os.type`, `host.arch`, `host.name`, `service.instance.id`
- `project.id` / `session.project_id` common attributes
- Global meter/logger provider registration (best-effort)

#### Multi-agent
- Delegation, context package, plan, todo, memory, MCP, workflow, command, file, compaction spans
- Keyed LLM `traceparent` injection with provider allowlist for `chat.headers`
- Conversation-aware sampling and W3C baggage for `gen_ai.conversation.id`

#### Quality
- Local span persistence (JSONL durable buffer)
- OTLP contract validation tests
- PII redaction enabled by default
- README, LICENSE, SECURITY.md, CONTRIBUTING.md, CI workflow
- 324+ unit/integration tests; `npm audit` 0 vulnerabilities

[1.0.0]: https://github.com/MunhozThiago/opencode-otel-plugin/releases/tag/v1.0.0
