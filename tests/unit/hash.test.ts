/**
 * opencode-otel-plugin - Hash Utility Tests
 */

import { describe, it, expect } from "vitest";
import {
  hashMemoryKey,
  hashString,
  generateAgentId,
  generateConversationId,
  generateSpanId,
  generateTraceId,
} from "../../dist/utils/hash.js";

describe("Hash Utilities", () => {
  describe("hashMemoryKey", () => {
    it("should prefix with mem_", () => {
      expect(hashMemoryKey("user.preferences")).toMatch(/^mem_[a-f0-9]+$/);
    });

    it("should be deterministic for same input", () => {
      expect(hashMemoryKey("key-1")).toBe(hashMemoryKey("key-1"));
    });

    it("should differ for different inputs", () => {
      expect(hashMemoryKey("key-1")).not.toBe(hashMemoryKey("key-2"));
    });
  });

  describe("hashString", () => {
    it("should return hex string", () => {
      expect(hashString("hello")).toMatch(/^[0-9a-f]+$/);
    });

    it("should be deterministic", () => {
      expect(hashString("content")).toBe(hashString("content"));
    });

    it("should differ for different content", () => {
      expect(hashString("a")).not.toBe(hashString("b"));
    });

    it("should handle empty string", () => {
      expect(hashString("")).toBe("0");
    });
  });

  describe("generateAgentId", () => {
    it("should match agent_ prefix with 12 hex chars", () => {
      expect(generateAgentId("planner", "sess-1")).toMatch(/^agent_[a-f0-9]{12}$/);
    });

    it("should be stable for same agent+session", () => {
      expect(generateAgentId("planner", "sess-1")).toBe(generateAgentId("planner", "sess-1"));
    });

    it("should change when session changes", () => {
      expect(generateAgentId("planner", "s1")).not.toBe(generateAgentId("planner", "s2"));
    });
  });

  describe("generateConversationId", () => {
    it("should prefix with conv_", () => {
      expect(generateConversationId("sess-1")).toBe("conv_sess-1");
    });
  });

  describe("generateSpanId", () => {
    it("should return 16 hex chars", () => {
      expect(generateSpanId()).toMatch(/^[a-f0-9]{16}$/);
    });

    it("should be unique across calls", () => {
      const ids = new Set(Array.from({ length: 50 }, () => generateSpanId()));
      expect(ids.size).toBe(50);
    });
  });

  describe("generateTraceId", () => {
    it("should return 32 hex chars", () => {
      expect(generateTraceId()).toMatch(/^[a-f0-9]{32}$/);
    });

    it("should not be all zeros", () => {
      expect(generateTraceId()).not.toBe("0".repeat(32));
    });

    it("should be unique across calls", () => {
      const ids = new Set(Array.from({ length: 50 }, () => generateTraceId()));
      expect(ids.size).toBe(50);
    });
  });
});
