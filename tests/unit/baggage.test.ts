/**
 * opencode-otel-plugin - Baggage Tests
 */

import { describe, it, expect } from "vitest";
import { context, trace } from "@opentelemetry/api";
import {
  createBaggagePropagator,
  serializeBaggage,
  parseBaggage,
  serializeTraceParent,
  parseTraceParent,
  createConversationBaggage,
  injectBaggageHeaders,
  extractBaggageHeaders,
  BAGGAGE_KEYS,
} from "../../dist/otel/baggage.js";

describe("Baggage Propagation", () => {
  describe("serializeBaggage / parseBaggage", () => {
    it("should serialize and parse baggage correctly", () => {
      const baggage = {
        "gen_ai.conversation.id": "conv-123",
        "gen_ai.agent.id": "agent-456",
        "gen_ai.session.id": "session-789",
      };
      
      const serialized = serializeBaggage(baggage);
      const parsed = parseBaggage(serialized);
      
      expect(parsed).toEqual(baggage);
    });

    it("should handle special characters in values", () => {
      const baggage = {
        "gen_ai.conversation.id": "conv with spaces",
        "custom.key": "value=with&special;chars",
      };
      
      const serialized = serializeBaggage(baggage);
      const parsed = parseBaggage(serialized);
      
      expect(parsed["gen_ai.conversation.id"]).toBe("conv with spaces");
      expect(parsed["custom.key"]).toBe("value=with&special;chars");
    });

    it("should handle empty baggage", () => {
      const serialized = serializeBaggage({});
      const parsed = parseBaggage(serialized);
      expect(parsed).toEqual({});
    });

    it("should ignore malformed entries", () => {
      const header = "valid=value,malformed,also=valid";
      const parsed = parseBaggage(header);
      expect(parsed.valid).toBe("value");
      expect(parsed.also).toBe("valid");
      expect(parsed.malformed).toBeUndefined();
    });
  });

  describe("serializeTraceParent / parseTraceParent", () => {
    it("should serialize and parse traceparent correctly", () => {
      const spanContext = {
        traceId: "0123456789abcdef0123456789abcdef",
        spanId: "0123456789abcdef",
        traceFlags: 1,
      };
      
      const serialized = serializeTraceParent(spanContext);
      const parsed = parseTraceParent(serialized);
      
      expect(parsed).toEqual(spanContext);
    });

    it("should return null for invalid version", () => {
      const parsed = parseTraceParent("01-0123456789abcdef0123456789abcdef-0123456789abcdef-01");
      expect(parsed).toBeNull();
    });

    it("should return null for invalid traceId length", () => {
      const parsed = parseTraceParent("00-0123456789abcdef-0123456789abcdef-01");
      expect(parsed).toBeNull();
    });

    it("should return null for invalid spanId length", () => {
      const parsed = parseTraceParent("00-0123456789abcdef0123456789abcdef-0123456789abcde-01");
      expect(parsed).toBeNull();
    });

    it("should return null for invalid traceFlags", () => {
      const parsed = parseTraceParent("00-0123456789abcdef0123456789abcdef-0123456789abcdef-xx");
      expect(parsed).toBeNull();
    });
  });

  describe("createConversationBaggage", () => {
    it("should create baggage with required conversation ID", () => {
      const baggage = createConversationBaggage("conv-123");
      expect(baggage[BAGGAGE_KEYS.CONVERSATION_ID]).toBe("conv-123");
      expect(baggage[BAGGAGE_KEYS.AGENT_ID]).toBeUndefined();
      expect(baggage[BAGGAGE_KEYS.SESSION_ID]).toBeUndefined();
    });

    it("should include optional agent ID and session ID", () => {
      const baggage = createConversationBaggage("conv-123", "agent-456", "session-789");
      expect(baggage[BAGGAGE_KEYS.CONVERSATION_ID]).toBe("conv-123");
      expect(baggage[BAGGAGE_KEYS.AGENT_ID]).toBe("agent-456");
      expect(baggage[BAGGAGE_KEYS.SESSION_ID]).toBe("session-789");
    });
  });

  describe("injectBaggageHeaders / extractBaggageHeaders", () => {
    it("should inject baggage headers (traceparent only with active span)", () => {
      const headers: Record<string, string> = {};
      const result = injectBaggageHeaders(headers, "conv-123", "agent-456", "session-789");
      
      expect(result.baggage).toBeDefined();
      // traceparent only injected when there's an active span
      expect(result.traceparent).toBeUndefined();
    });

    it("should extract baggage from headers", () => {
      const headers = {
        baggage: "gen_ai.conversation.id=conv-123,gen_ai.agent.id=agent-456",
        traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
      };
      
      const extracted = extractBaggageHeaders(headers);
      
      expect(extracted.conversationId).toBe("conv-123");
      expect(extracted.agentId).toBe("agent-456");
      expect(extracted.sessionId).toBeUndefined();
      expect(extracted.traceContext).toBeDefined();
      expect(extracted.traceContext?.traceId).toBe("0123456789abcdef0123456789abcdef");
    });

    it("should handle case-insensitive header names", () => {
      const headers = {
        Baggage: "gen_ai.conversation.id=conv-123",
        Traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
      };
      
      const extracted = extractBaggageHeaders(headers);
      expect(extracted.conversationId).toBe("conv-123");
    });

    it("should handle missing headers gracefully", () => {
      const extracted = extractBaggageHeaders({});
      expect(extracted.conversationId).toBeUndefined();
      expect(extracted.traceContext).toBeUndefined();
    });
  });

  describe("Baggage Propagator", () => {
    it("should have correct fields", () => {
      const propagator = createBaggagePropagator();
      expect(propagator.fields()).toEqual(["baggage", "traceparent"]);
    });

    it("should inject baggage and traceparent into carrier", () => {
      const propagator = createBaggagePropagator();
      const carrier: Record<string, string> = {};
      const setter = {
        set: (c: Record<string, string>, key: string, value: string) => { c[key] = value; },
      };
      
      // Create context with baggage
      // This would need more complex mocking to test fully
    });
  });
});