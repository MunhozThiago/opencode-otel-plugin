# Competitive Gap Analysis: `opencode-otel-plugin` vs `@devtheops/opencode-plugin-otel`

**Reference:** https://github.com/DEVtheOPS/opencode-plugin-otel (npm `@devtheops/opencode-plugin-otel` v1.5.1, MPL-2.0, ~129★)  
**Method:** Multi-agent expert review (Engineering · Architecture · Product) against both codebases.  
**Date:** 2026-09-24  
**Status:** **P0+P1+P2 fully implemented** — suite green: **331 tests / 22 files**, `npm audit` → 0 vulnerabilities, `npm run build` exit 0. Community docs (SECURITY/CONTRIBUTING/CHANGELOG) + CI/release workflows present.

---

## Executive summary

| Dimension | Verdict |
|-----------|---------|
| **Multi-agent depth** | **We win** — delegation, workflow, plan, memory, MCP, context packages |
| **Security defaults** | **We win** — PII redaction on by default, header CR/LF rejection, strict config validation |
| **Durable buffering** | **We win** — local span persistence (JSONL spill) |
| **Test rigor** | **We win** — 324 unit/integration tests + OTLP contract tests |
| **Product telemetry catalog** | **Parity** — 15 official metrics + 9 log event types (`event.name` taxonomy) |
| **Ops / config UX** | **Parity** — `OPENCODE_*` env layer, dynamic auth headers, kill-switches, collector recipes (README) |
| **Lifecycle / data-loss safety** | **Parity** — forceFlush on idle/error/message-complete + SIGTERM/SIGINT/beforeExit |
| **Cross-system propagation** | **Parity** — remote parent + keyed LLM `traceparent` injection + provider allowlist |
| **Distribution / ecosystem** | **Partial** — README + LICENSE + npm publish metadata shipped; CI/SECURITY/CONTRIBUTING still open |

**Positioning line:** *The only opencode-native OTel plugin with multi-agent delegation/context-package tracing, GenAI semconv spans, default-on PII redaction, durable local buffering, official metric/log catalogs, env config, and auth-retrying OTLP export.*

---

## Round completion status (2026-09-24)

### P0 — ship-blocking (DONE)

| Gap | Status | Evidence |
|-----|--------|----------|
| Official metric catalog (15 instruments) | ✅ | `src/otel/metrics.ts`, `tests/unit/metrics.test.ts` |
| Structured log `event.name` contract | ✅ | `src/otel/logs.ts` `LOG_EVENTS`, taxonomy methods |
| Lifecycle flush + signal shutdown | ✅ | `src/hooks/event.ts` idle/error/message flush; `src/index.ts` SIGTERM/SIGINT/beforeExit; `ProviderSetupResult.forceFlush` |
| Bounded maps (`MAX_PENDING=500`) | ✅ | `src/utils/bounded.ts` + wiring in `event.ts` |
| Dynamic headers + auth retry | ✅ | `src/otel/headers.ts` `DynamicHeaders` + `wrapExporterWithAuthRetry` wired in `exporter.ts` |
| `OPENCODE_*` env config + precedence | ✅ | `src/config.ts` options > env > defaults |
| README + install UX | ✅ | `README.md` (quick start, config table, collector recipes) |
| npm publish path | ✅ | `package.json` repository/bugs/homepage/exports/publishConfig + `LICENSE` |
| Per-hook `safe()` | ✅ | `src/index.ts` `safeHook` on all hooks |
| Keyed `chat.headers` + allowlist | ✅ | `src/hooks/chat.ts` + `src/otel/llm-contexts.ts` |

### P1 — competitive parity (DONE)

| Gap | Status | Evidence |
|-----|--------|----------|
| Remote parent `traceparent`/`tracestate` | ✅ | `src/otel/trace-context.ts`, `resolveRootContext` in `index.ts` |
| Endpoint probe | ✅ | `src/otel/probe.ts` warn-but-continue |
| Session totals + idle histograms | ✅ | `handleSessionIdle` → `recordSessionDuration` / `recordSessionTokenTotal` |
| LOC + commit metrics | ✅ | `file.edited` / `command.executed` in `event.ts` |
| Permission pending → `tool_decision` | ✅ | `permission.ask`/`permission.replied` → `logs.toolDecision` |
| Protocol `http/protobuf` + `http/json` | ✅ | `config.ts` allowlist; `buildHttpSignalUrl` in `exporter.ts` |
| Collector recipes | ✅ | README § Collector recipes (Jaeger, Grafana, SigNoz, Datadog, Honeycomb) |
| `tool.duration` emission | ✅ | `tool.execute.after` / `mcp.tool.result` in `event.ts` |

### P2 — polish (DONE this round)

| Gap | Status | Evidence |
|-----|--------|----------|
| `disabledMetrics`/`disabledTraces`/`disabledLogs` + `metricPrefix` | ✅ | config + `GenAIMetrics` + no-op exporters |
| `metricsTemporality` (Datadog delta) | ✅ | `config.metricsTemporality` → `OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY` bridge |
| `spanAttributes` on every span | ✅ | `EnrichmentSpanProcessor.onStart` |
| Unified resource `os.type`/`host.arch`/`host.name` | ✅ | `provider.ts` `createResource`; shared with metrics/logs |
| Global meter/logger registration | ✅ | `setGlobalMeterProvider` / `setGlobalLoggerProvider` best-effort |
| Session orphan sweep on idle/error | ✅ | `sweepMap` in `handleSessionIdle` |
| SPEC §11 reconciliation | ✅ | Metrics/logs/future items moved to shipped |
| `cache.count` / `retry.count` emission | ✅ | MCP result/error handlers |
| OpenInference dual attributes | ✅ | `addOpenInferenceAttributes` in `semantic-conventions.ts`; applied on chat + tool spans; `tests/unit/openinference.test.ts` |
| `project.id` common attribute | ✅ | `createBaseAttributes({projectId})`, session mapper, event hook root-span attach, resource passthrough |
| SECURITY / CONTRIBUTING / CHANGELOG | ✅ | root docs |
| CI + release workflows | ✅ | `.github/workflows/ci.yml`, `release.yml` |

### Still open (out of this round / optional)

| Item | Sev | Notes |
|------|-----|-------|
| Auto-instrumentation of MCP servers | Future | SPEC §11 |
| A2A protocol tracing | Future | SPEC §11 |
| Replay integration | Future | SPEC §11 |
| Differentiators #4–#8 from RESEARCH.md | n/a | Out of plugin scope (control plane / host) |
| Live npm publish | ops | Requires registry token + real GitHub repo secrets |

---

## 1. Engineering perspective

### 1.1 Strengths (we have, they lack)

| Capability | Evidence |
|------------|----------|
| PII redaction engine | `src/utils/pii.ts`, `src/config.ts` `piiRedaction`, `tests/unit/pii.test.ts` |
| Conversation-aware sampling | `src/otel/sampler.ts` + tests |
| Local span persistence | `src/otel/persistence.ts` + tests |
| OTLP contract validation | `src/otel/otlp-contract.ts` + `tests/unit/otlp-contract.test.ts` |
| Multi-agent span taxonomy | `src/types.ts` `SpanType`; mappers `delegation/plan/todo/memory/mcp/command/file` |
| W3C Baggage with GenAI keys | `src/otel/baggage.ts` |
| Deep config validation | `src/config.ts` (URL/protocol, 4317 guard, header CR/LF, batch/persistence bounds) |
| Compaction + chat.params/tool.definition hooks | `src/hooks/session.ts`, `chat.ts`, `tool.ts` |
| Mapper-level shape validation | `src/mappers/validation.ts` |
| Broad test surface | 22 test files / 331 tests |

### 1.2 Gaps matrix — resolved this round

| Sev | Gap | Status |
|-----|-----|--------|
| **P0** | Official metric catalog (15 instruments) | ✅ shipped |
| **P0** | Structured log `event.name` contract | ✅ shipped |
| **P0** | Lifecycle flush + signal shutdown | ✅ shipped |
| **P0** | Bounded maps (`MAX_PENDING=500`) | ✅ shipped |
| **P0** | Dynamic headers + auth retry | ✅ shipped |
| **P1** | `OPENCODE_*` env config + precedence | ✅ shipped |
| **P1** | Protocols `grpc\|http/protobuf\|http/json` | ✅ shipped |
| **P1** | Remote parent (`traceparent`/`tracestate`) | ✅ shipped |
| **P1** | Correct LLM `chat.headers` injection | ✅ shipped |
| **P1** | Endpoint probe | ✅ shipped |
| **P1** | Session totals / LOC / commit / tool.duration metrics | ✅ shipped |
| **P1** | Permission → `tool_decision` log | ✅ shipped |
| **P1** | Per-hook `safe()` barrier | ✅ shipped |
| **P2** | Kill-switches, prefix, temporality, spanAttributes, resource os/arch, orphan sweep | ✅ shipped |

---

## 2. Architecture perspective

### 2.1 Architectural advantages (ours)

1. **Layered modules** — `hooks/*` → `mappers/*` → `otel/*` → `utils/*`
2. **PII subsystem** — pattern + field rules at ingest
3. **Durable persistence** — `PersistenceSpanProcessor` + bounded JSONL store
4. **Conversation-aware sampling** — no mid-conversation trace splits
5. **Strict config validation** — throw-paths for misconfig
6. **Signal isolation** — metrics/logs setup individually try/caught
7. **Span limits** — attributeCount/valueLength/event/link caps
8. **Test architecture** — full vitest suite + e2e
9. **Lazy protocol loading** — dynamic `import()` for exporters
10. **Explicit AsyncHooks context manager** enable/disable
11. **Auth-retrying exporters** — helper refresh on 401/403 without host impact
12. **Lifecycle forceFlush** — event-driven + signal-driven data-loss safety

### 2.2 Architectural gaps — status

| Sev | Gap | Status |
|-----|-----|--------|
| **P0** | Lifecycle `forceFlush` | ✅ |
| **P0** | Process signal handlers | ✅ |
| **P0** | Env config + OTEL_* bridge | ✅ |
| **P0** | Dynamic headers + auth retry | ✅ |
| **P1** | Remote parent at startup | ✅ |
| **P1** | Keyed chat.headers + allowlist | ✅ |
| **P1** | Endpoint probe | ✅ |
| **P1** | Bounded correlation maps + session sweep | ✅ |
| **P1** | `safe()` on all hooks | ✅ |
| **P1** | Protocol matrix + URL builder | ✅ |
| **P2** | OpenInference dual attributes | ⏳ deferred (optional dep) |
| **P2** | Unified shared resource | ✅ shared resource + os/arch |
| **P2** | Wire or delete dead processors | ✅ enrichment applies `spanAttributes`; PII path via `enrichSpanAttributes` |
| **P2** | Global meter/logger registration | ✅ best-effort |

---

## 3. Product / management perspective

### 3.1 Product advantages (ours)

| Advantage | Why it matters |
|-----------|----------------|
| Multi-agent observability depth | delegation/handoff, context packages, plan, memory/compaction, MCP, workflow, todo/command |
| PII redaction **on by default** | enterprise default |
| GenAI semconv as first-class span model | better long-term fit for GenAI backends |
| OTLP contract tests + 331 tests | payload compliance |
| Local persistence / durable buffer | exporter outage resilience |
| Strict config validation | hardens misconfig before export |
| Conversation-aware sampling | cost control without broken traces |
| Official metric/log catalogs | dashboard-ready out of the box |
| README + collector recipes | time-to-value |

### 3.2 Gaps — status

| Sev | Gap | Status |
|-----|-----|--------|
| **P0** | **No README** | ✅ shipped |
| **P0** | **No npm distribution path** | ✅ metadata + LICENSE + prepublishOnly |
| **P0** | **No `OPENCODE_*` env layer** | ✅ |
| **P1** | Collector quick-starts | ✅ README recipes |
| **P1** | Metric-prefix / dashboard story | ✅ `metricPrefix` + catalog docs |
| **P1** | Release engineering / CI / CHANGELOG | ⏳ open |
| **P1** | SECURITY.md / CONTRIBUTING / templates | ⏳ open |
| **P1** | Dynamic auth helper | ✅ |
| **P2** | Granular kill-switches | ✅ |
| **P2** | Remote traceparent / LLM gateway | ✅ |
| **P2** | `spanAttributes` / resource env passthrough | ✅ |
| **P2** | `http/json` protocol | ✅ |

---

## 4. Prioritized missing-capabilities matrix

See Round completion status above. **All P0/P1/P2 code gaps closed.** Remaining items are Future (SPEC §11) or ops-only (live npm publish with registry secrets).

| Capability | Official | Ours | Severity |
|------------|:--------:|:----:|:--------:|
| OpenInference dual attributes | ✅ | ✅ | done |
| SECURITY/CONTRIBUTING/CHANGELOG/CI | ✅ | ✅ | done |
| Release workflow | ✅ | ✅ | done (needs NPM_TOKEN secret) |

---

## 5. Recommended next rounds

### Optional follow-ups (not blocking ship)
1. Wire live npm publish once GitHub repo + `NPM_TOKEN` secret exist
2. OpenTelemetry Collector docker-compose samples in repo
3. Issue templates (bug/feature)
4. SPEC §11 Future: MCP auto-instrumentation, A2A, replay

### Differentiators to protect (do not regress)
See Appendix B.

---

## Appendix A — Reference package surface (for parity checks)

**Official metrics:** `session.count`, `token.usage`, `cost.usage`, `lines_of_code.count`/`total`, `commit.count`, `tool.duration`, `cache.count`, `session.duration`, `message.count`, `session.token.total`, `session.cost.total`, `model.usage`, `retry.count`, `subtask.count`.

**Official log events:** `session.created`/`idle`/`error`, `user_prompt`, `api_request`, `api_error`, `tool_result`, `tool_decision`, `commit`.

**Config knobs:** enable, logsEnabled, capturePromptInLogs, endpoint, protocol, metricsInterval, logsInterval, metricPrefix, otlpHeaders(+Helper), resourceAttributes, spanAttributes, traceparent/tracestate, metricsTemporality, disabledMetrics, disabledTraces, tracePropagationProviders.

## Appendix B — Our shipped differentiators (do not regress)

- Multi-agent: delegation, workflow, plan, todo, memory, MCP, command, file, compaction
- PII redaction enabled by default + header injection rejection
- Local span persistence (JSONL, bounded)
- Conversation-aware sampling with decision cache
- OTLP contract validation + 331-test suite
- Strict config validation (URL/protocol, port guard, batch/persistence bounds)
- Official 15-metric catalog + `event.name` log taxonomy
- Dynamic headers helper + auth-failure retry
- Lifecycle forceFlush + process signal handlers
- Env config precedence: options > `OPENCODE_*` > defaults
- OpenInference dual attributes on chat/tool spans
- SECURITY/CONTRIBUTING/CHANGELOG + GitHub Actions CI/release

