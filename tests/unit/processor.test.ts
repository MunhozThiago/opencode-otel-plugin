/**
 * opencode-otel-plugin - Span Processor Tests
 */

import { describe, it, expect, vi } from "vitest";
import {
  EnrichmentSpanProcessor,
  PIIRedactionProcessor,
  enrichSpanAttributes,
} from "../../dist/otel/processor.js";
import { PIIRedactor } from "../../dist/utils/pii.js";

function createMockSpan(): any {
  return {
    setAttribute: vi.fn(),
    name: "test-span",
    attributes: {},
    spanContext: () => ({
      traceId: "0123456789abcdef0123456789abcdef",
      spanId: "0123456789abcdef",
      traceFlags: 1,
    }),
  };
}

function createRedactor(): PIIRedactor {
  return new PIIRedactor({
    enabled: true,
    patterns: [],
    defaultFields: ["apiKey", "password", "token"],
  } as any);
}

describe("Span Processors", () => {
  describe("EnrichmentSpanProcessor", () => {
    it("should construct with redactor and debug flag", () => {
      const p = new EnrichmentSpanProcessor(createRedactor(), false);
      expect(p).toBeDefined();
    });

    it("onStart should be a no-op without throwing", () => {
      const p = new EnrichmentSpanProcessor(createRedactor(), false);
      const span = createMockSpan();
      expect(() => p.onStart(span as any, span.spanContext())).not.toThrow();
    });

    it("onEnd should not throw", () => {
      const p = new EnrichmentSpanProcessor(createRedactor(), true);
      const span = createMockSpan();
      expect(() => p.onEnd(span as any)).not.toThrow();
    });

    it("shutdown and forceFlush should resolve", async () => {
      const p = new EnrichmentSpanProcessor(createRedactor(), false);
      await expect(p.shutdown()).resolves.toBeUndefined();
      await expect(p.forceFlush()).resolves.toBeUndefined();
    });
  });

  describe("PIIRedactionProcessor", () => {
    it("should construct with redactor", () => {
      const p = new PIIRedactionProcessor(createRedactor());
      expect(p).toBeDefined();
    });

    it("onStart/onEnd should not throw", () => {
      const p = new PIIRedactionProcessor(createRedactor());
      const span = createMockSpan();
      expect(() => p.onStart(span as any, span.spanContext())).not.toThrow();
      expect(() => p.onEnd(span as any)).not.toThrow();
    });

    it("shutdown and forceFlush should resolve", async () => {
      const p = new PIIRedactionProcessor(createRedactor());
      await expect(p.shutdown()).resolves.toBeUndefined();
      await expect(p.forceFlush()).resolves.toBeUndefined();
    });
  });

  describe("enrichSpanAttributes", () => {
    it("should set redacted attributes on span", () => {
      const span = createMockSpan();
      enrichSpanAttributes(
        span,
        { "session.id": "s1", "gen_ai.operation.name": "chat" } as any,
        createRedactor()
      );
      expect(span.setAttribute).toHaveBeenCalledWith("session.id", "s1");
      expect(span.setAttribute).toHaveBeenCalledWith("gen_ai.operation.name", "chat");
    });

    it("should redact sensitive field values", () => {
      const span = createMockSpan();
      enrichSpanAttributes(
        span,
        { apiKey: "super-secret-value-12345", "session.id": "s1" } as any,
        createRedactor()
      );
      const apiKeyCall = (span.setAttribute as ReturnType<typeof vi.fn>).mock.calls.find(
        (c) => c[0] === "apiKey"
      );
      expect(apiKeyCall).toBeDefined();
      expect(apiKeyCall![1]).toBe("[REDACTED]");
    });

    it("should skip null/undefined attribute values", () => {
      const span = createMockSpan();
      enrichSpanAttributes(
        span,
        { "session.id": "s1", "optional.field": null } as any,
        createRedactor()
      );
      const calls = (span.setAttribute as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.some((c: any[]) => c[0] === "optional.field")).toBe(false);
    });
  });
});
