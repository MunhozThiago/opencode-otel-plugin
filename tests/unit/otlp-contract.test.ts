/**
 * opencode-otel-plugin - OTLP Contract Tests
 * 
 * Contract tests for OTLP payload validation (RESEARCH.md gap #10).
 */

import { describe, it, expect } from "vitest";
import {
  validateOTLPTracePayload,
  validateGenAIAttributes,
  validateMultiAgentAttributes,
  isValidTraceId,
  isValidSpanId,
} from "../../src/otel/otlp-contract.js";
import type { OTLPExportTraceServiceRequest } from "../../src/otel/otlp-contract.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function createValidSpan(overrides: any = {}): any {
  return {
    traceId: "0123456789abcdef0123456789abcdef",
    spanId: "0123456789abcdef",
    name: "test-span",
    kind: 2, // CLIENT
    startTimeUnixNano: "1700000000000000000",
    endTimeUnixNano: "1700000001000000000",
    attributes: [
      { key: "service.name", value: { stringValue: "test-service" } },
      { key: "gen_ai.operation.name", value: { stringValue: "chat" } },
      { key: "gen_ai.provider.name", value: { stringValue: "openai" } },
      { key: "gen_ai.request.model", value: { stringValue: "gpt-4" } },
      { key: "gen_ai.token_usage.input", value: { intValue: "100" } },
      { key: "gen_ai.token_usage.output", value: { intValue: "50" } },
    ],
    events: [],
    links: [],
    status: { code: 1 }, // OK
    ...overrides,
  };
}

function createValidPayload(): OTLPExportTraceServiceRequest {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: "service.name", value: { stringValue: "opencode" } },
            { key: "service.version", value: { stringValue: "1.0.0" } },
            { key: "telemetry.sdk.language", value: { stringValue: "nodejs" } },
          ],
        },
        scopeSpans: [
          {
            scope: {
              name: "opencode-otel-plugin",
              version: "1.0.0",
              attributes: [],
            },
            spans: [createValidSpan()],
          },
        ],
      },
    ],
  };
}

// ─── OTLP Trace Payload Validation ────────────────────────────────────────────

describe("OTLP Trace Payload Contract", () => {
  it("should validate a valid OTLP payload", () => {
    const payload = createValidPayload();
    const result = validateOTLPTracePayload(payload);
    
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("should reject null payload", () => {
    const result = validateOTLPTracePayload(null);
    
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Payload must be an object");
  });

  it("should reject payload without resourceSpans", () => {
    const result = validateOTLPTracePayload({});
    
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("resourceSpans must be an array");
  });

  it("should reject empty resourceSpans with warning", () => {
    const result = validateOTLPTracePayload({ resourceSpans: [] });
    
    expect(result.valid).toBe(true);
    expect(result.warnings).toContain("resourceSpans is empty");
  });

  it("should reject resourceSpan without resource", () => {
    const payload = {
      resourceSpans: [
        {
          scopeSpans: [],
        },
      ],
    };
    
    const result = validateOTLPTracePayload(payload);
    
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("resourceSpans[0].resource is required");
  });

  it("should validate span traceId format (32 hex chars)", () => {
    const span = createValidSpan({ traceId: "invalid" });
    const payload = createValidPayload();
    payload.resourceSpans[0].scopeSpans[0].spans[0] = span;
    
    const result = validateOTLPTracePayload(payload);
    
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("traceId must be 32 hex characters"))).toBe(true);
  });

  it("should validate span spanId format (16 hex chars)", () => {
    const span = createValidSpan({ spanId: "tooshort" });
    const payload = createValidPayload();
    payload.resourceSpans[0].scopeSpans[0].spans[0] = span;
    
    const result = validateOTLPTracePayload(payload);
    
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("spanId must be 16 hex characters"))).toBe(true);
  });

  it("should validate span kind range (0-4)", () => {
    const span = createValidSpan({ kind: 5 });
    const payload = createValidPayload();
    payload.resourceSpans[0].scopeSpans[0].spans[0] = span;
    
    const result = validateOTLPTracePayload(payload);
    
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("kind must be between 0 and 4"))).toBe(true);
  });

  it("should validate required span fields", () => {
    const span = createValidSpan({
      traceId: undefined,
      spanId: undefined,
      name: undefined,
      kind: undefined,
      startTimeUnixNano: undefined,
      endTimeUnixNano: undefined,
    });
    const payload = createValidPayload();
    payload.resourceSpans[0].scopeSpans[0].spans[0] = span;
    
    const result = validateOTLPTracePayload(payload);
    
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("traceId is required"))).toBe(true);
    expect(result.errors.some(e => e.includes("spanId is required"))).toBe(true);
    expect(result.errors.some(e => e.includes("name is required"))).toBe(true);
    expect(result.errors.some(e => e.includes("kind is required"))).toBe(true);
    expect(result.errors.some(e => e.includes("startTimeUnixNano is required"))).toBe(true);
    expect(result.errors.some(e => e.includes("endTimeUnixNano is required"))).toBe(true);
  });

  it("should validate attribute structure", () => {
    const span = createValidSpan({
      attributes: [
        { key: "valid.attr", value: { stringValue: "test" } },
        { key: "invalid.attr" }, // missing value
        { value: { stringValue: "no-key" } }, // missing key
      ],
    });
    const payload = createValidPayload();
    payload.resourceSpans[0].scopeSpans[0].spans[0] = span;
    
    const result = validateOTLPTracePayload(payload);
    
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("value is required"))).toBe(true);
    expect(result.errors.some(e => e.includes("key is required"))).toBe(true);
  });

  it("should validate status code range (0-2)", () => {
    const span = createValidSpan({
      status: { code: 3 },
    });
    const payload = createValidPayload();
    payload.resourceSpans[0].scopeSpans[0].spans[0] = span;
    
    const result = validateOTLPTracePayload(payload);
    
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("status.code must be 0"))).toBe(true);
  });

  it("should warn about missing GenAI attributes", () => {
    const span = createValidSpan({
      attributes: [
        { key: "service.name", value: { stringValue: "test" } },
      ],
    });
    const payload = createValidPayload();
    payload.resourceSpans[0].scopeSpans[0].spans[0] = span;
    
    const result = validateOTLPTracePayload(payload);
    
    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => w.includes("gen_ai.*"))).toBe(true);
  });

  it("should warn about missing service.name", () => {
    const payload = createValidPayload();
    payload.resourceSpans[0].resource.attributes = [];
    
    const result = validateOTLPTracePayload(payload);
    
    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => w.includes("service.name"))).toBe(true);
  });
});

// ─── GenAI Attributes Validation ──────────────────────────────────────────────

describe("GenAI Attributes Contract", () => {
  it("should validate required GenAI attributes", () => {
    const attributes = [
      { key: "gen_ai.operation.name", value: { stringValue: "chat" } },
      { key: "gen_ai.provider.name", value: { stringValue: "openai" } },
      { key: "gen_ai.request.model", value: { stringValue: "gpt-4" } },
      { key: "gen_ai.token_usage.input", value: { intValue: "100" } },
    ];
    
    const result = validateGenAIAttributes(attributes);
    
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("should reject missing required GenAI attributes", () => {
    const attributes = [
      { key: "gen_ai.request.model", value: { stringValue: "gpt-4" } },
    ];
    
    const result = validateGenAIAttributes(attributes);
    
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Missing required GenAI attribute: gen_ai.operation.name");
    expect(result.errors).toContain("Missing required GenAI attribute: gen_ai.provider.name");
  });

  it("should warn about missing recommended GenAI attributes", () => {
    const attributes = [
      { key: "gen_ai.operation.name", value: { stringValue: "chat" } },
      { key: "gen_ai.provider.name", value: { stringValue: "openai" } },
    ];
    
    const result = validateGenAIAttributes(attributes);
    
    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => w.includes("gen_ai.request.model"))).toBe(true);
    expect(result.warnings.some(w => w.includes("gen_ai.token_usage.input"))).toBe(true);
  });
});

// ─── Multi-Agent Attributes Validation ────────────────────────────────────────

describe("Multi-Agent Attributes Contract", () => {
  it("should validate multi-agent attributes", () => {
    const attributes = [
      { key: "gen_ai.conversation.id", value: { stringValue: "conv_123" } },
      { key: "gen_ai.agent.id", value: { stringValue: "agent_abc" } },
    ];
    
    const result = validateMultiAgentAttributes(attributes);
    
    expect(result.valid).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it("should warn about missing multi-agent attributes", () => {
    const attributes = [
      { key: "gen_ai.operation.name", value: { stringValue: "chat" } },
    ];
    
    const result = validateMultiAgentAttributes(attributes);
    
    expect(result.valid).toBe(true);
    expect(result.warnings.some(w => w.includes("gen_ai.conversation.id"))).toBe(true);
    expect(result.warnings.some(w => w.includes("gen_ai.agent.id"))).toBe(true);
  });
});

// ─── Hex ID Validation ────────────────────────────────────────────────────────

describe("Hex ID Validation", () => {
  it("should validate correct trace ID", () => {
    expect(isValidTraceId("0123456789abcdef0123456789abcdef")).toBe(true);
  });

  it("should reject invalid trace ID", () => {
    expect(isValidTraceId("invalid")).toBe(false);
    expect(isValidTraceId("0123456789abcdef")).toBe(false); // too short
    expect(isValidTraceId("0".repeat(32))).toBe(false); // all zeros
  });

  it("should validate correct span ID", () => {
    expect(isValidSpanId("0123456789abcdef")).toBe(true);
  });

  it("should reject invalid span ID", () => {
    expect(isValidSpanId("invalid")).toBe(false);
    expect(isValidSpanId("0123456789abcdef0123")).toBe(false); // too long
    expect(isValidSpanId("0".repeat(16))).toBe(false); // all zeros
  });
});

// ─── Multi-Agent Span Contract ────────────────────────────────────────────────

describe("Multi-Agent Span Contract", () => {
  it("should validate a complete multi-agent delegation span", () => {
    const delegationSpan = createValidSpan({
      name: "invoke_agent",
      kind: 2, // CLIENT
      attributes: [
        { key: "service.name", value: { stringValue: "opencode" } },
        { key: "gen_ai.operation.name", value: { stringValue: "invoke_agent" } },
        { key: "gen_ai.provider.name", value: { stringValue: "anthropic" } },
        { key: "gen_ai.agent.id", value: { stringValue: "agent_planner" } },
        { key: "gen_ai.agent.name", value: { stringValue: "planner" } },
        { key: "gen_ai.conversation.id", value: { stringValue: "conv_session-123" } },
        { key: "gen_ai.session.id", value: { stringValue: "session-123" } },
        { key: "agent.delegation.from_agent_id", value: { stringValue: "agent_planner" } },
        { key: "agent.delegation.to_agent_id", value: { stringValue: "agent_coder" } },
        { key: "agent.delegation.rationale", value: { stringValue: "Need to implement feature" } },
        { key: "agent.context.package.tokens_sent", value: { intValue: "5000" } },
        { key: "agent.context.package.tokens_received", value: { intValue: "4500" } },
        { key: "agent.context.package.truncated", value: { boolValue: false } },
      ],
    });
    
    const payload = createValidPayload();
    payload.resourceSpans[0].scopeSpans[0].spans[0] = delegationSpan;
    
    const result = validateOTLPTracePayload(payload);
    expect(result.valid).toBe(true);
    
    const genAIResult = validateGenAIAttributes(delegationSpan.attributes);
    expect(genAIResult.valid).toBe(true);
    
    const multiAgentResult = validateMultiAgentAttributes(delegationSpan.attributes);
    expect(multiAgentResult.valid).toBe(true);
    expect(multiAgentResult.warnings).toHaveLength(0);
  });

  it("should validate a complete chat span with token usage", () => {
    const chatSpan = createValidSpan({
      name: "chat",
      kind: 2,
      attributes: [
        { key: "service.name", value: { stringValue: "opencode" } },
        { key: "gen_ai.operation.name", value: { stringValue: "chat" } },
        { key: "gen_ai.provider.name", value: { stringValue: "openai" } },
        { key: "gen_ai.request.model", value: { stringValue: "gpt-4" } },
        { key: "gen_ai.response.model", value: { stringValue: "gpt-4" } },
        { key: "gen_ai.system", value: { stringValue: "openai" } },
        { key: "gen_ai.token_usage.input", value: { intValue: "150" } },
        { key: "gen_ai.token_usage.output", value: { intValue: "75" } },
        { key: "gen_ai.token_usage.total", value: { intValue: "225" } },
        { key: "gen_ai.conversation.id", value: { stringValue: "conv_session-123" } },
        { key: "gen_ai.agent.id", value: { stringValue: "agent_primary" } },
      ],
    });
    
    const payload = createValidPayload();
    payload.resourceSpans[0].scopeSpans[0].spans[0] = chatSpan;
    
    const result = validateOTLPTracePayload(payload);
    expect(result.valid).toBe(true);
    
    const genAIResult = validateGenAIAttributes(chatSpan.attributes);
    expect(genAIResult.valid).toBe(true);
    expect(genAIResult.warnings).toHaveLength(0);
  });

  it("should validate a complete tool execution span", () => {
    const toolSpan = createValidSpan({
      name: "execute_tool",
      kind: 2,
      attributes: [
        { key: "service.name", value: { stringValue: "opencode" } },
        { key: "gen_ai.operation.name", value: { stringValue: "execute_tool" } },
        { key: "gen_ai.provider.name", value: { stringValue: "openai" } },
        { key: "gen_ai.tool.name", value: { stringValue: "read_file" } },
        { key: "gen_ai.tool.call_id", value: { stringValue: "call_abc123" } },
        { key: "gen_ai.tool.duration_ms", value: { intValue: "150" } },
        { key: "gen_ai.conversation.id", value: { stringValue: "conv_session-123" } },
        { key: "gen_ai.agent.id", value: { stringValue: "agent_primary" } },
      ],
    });
    
    const payload = createValidPayload();
    payload.resourceSpans[0].scopeSpans[0].spans[0] = toolSpan;
    
    const result = validateOTLPTracePayload(payload);
    expect(result.valid).toBe(true);
  });
});
