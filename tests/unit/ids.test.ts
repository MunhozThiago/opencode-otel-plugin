/**
 * opencode-otel-plugin - ID/Context Utilities Tests
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  generateAgentId,
  generateConversationId,
  generateSpanId,
  generateTraceId,
  hashMemoryKey,
  hashString,
  estimateTokens,
  createContextPackage,
  calculateContextFill,
  diffContextPackages,
  getOrCreateConversationContext,
  getConversationContext,
  clearConversationContext,
  extractAgentInfo,
} from "../../dist/utils/ids.js";

describe("ID Generation", () => {
  describe("generateAgentId", () => {
    it("should generate consistent ID for same inputs", () => {
      const id1 = generateAgentId("my-agent", "session-123");
      const id2 = generateAgentId("my-agent", "session-123");
      expect(id1).toBe(id2);
    });

    it("should generate different IDs for different agents", () => {
      const id1 = generateAgentId("agent-1", "session-123");
      const id2 = generateAgentId("agent-2", "session-123");
      expect(id1).not.toBe(id2);
    });

    it("should generate different IDs for different sessions", () => {
      const id1 = generateAgentId("my-agent", "session-1");
      const id2 = generateAgentId("my-agent", "session-2");
      expect(id1).not.toBe(id2);
    });

    it("should have correct prefix", () => {
      const id = generateAgentId("test", "session");
      expect(id).toMatch(/^agent_[a-f0-9]{12}$/);
    });
  });

  describe("generateConversationId", () => {
    it("should generate consistent ID for same session", () => {
      const id1 = generateConversationId("session-123");
      const id2 = generateConversationId("session-123");
      expect(id1).toBe(id2);
    });

    it("should have correct prefix", () => {
      const id = generateConversationId("session-123");
      expect(id).toMatch(/^conv_session-123$/);
    });
  });

  describe("generateSpanId", () => {
    it("should generate 16-char hex string", () => {
      const id = generateSpanId();
      expect(id).toMatch(/^[a-f0-9]{16}$/);
    });

    it("should generate unique IDs", () => {
      const ids = new Set();
      for (let i = 0; i < 100; i++) {
        ids.add(generateSpanId());
      }
      expect(ids.size).toBe(100);
    });
  });

  describe("generateTraceId", () => {
    it("should generate 32-char hex string", () => {
      const id = generateTraceId();
      expect(id).toMatch(/^[a-f0-9]{32}$/);
    });

    it("should generate unique IDs", () => {
      const ids = new Set();
      for (let i = 0; i < 100; i++) {
        ids.add(generateTraceId());
      }
      expect(ids.size).toBe(100);
    });
  });
});

describe("Hashing", () => {
  describe("hashMemoryKey", () => {
    it("should produce consistent hash", () => {
      const hash1 = hashMemoryKey("my-secret-key");
      const hash2 = hashMemoryKey("my-secret-key");
      expect(hash1).toBe(hash2);
    });

    it("should produce different hashes for different keys", () => {
      const hash1 = hashMemoryKey("key1");
      const hash2 = hashMemoryKey("key2");
      expect(hash1).not.toBe(hash2);
    });

    it("should have correct format", () => {
      const hash = hashMemoryKey("test");
      expect(hash).toMatch(/^mem_[a-f0-9]{8}$/);
    });
  });

  describe("hashString", () => {
    it("should produce consistent hash", () => {
      const hash1 = hashString("test string");
      const hash2 = hashString("test string");
      expect(hash1).toBe(hash2);
    });

    it("should produce hex string", () => {
      const hash = hashString("test");
      expect(hash).toMatch(/^[a-f0-9]+$/);
    });
  });
});

describe("Context Window Utilities", () => {
  describe("estimateTokens", () => {
    it("should estimate tokens roughly", () => {
      // ~4 chars per token
      expect(estimateTokens("hello")).toBe(2); // 5 chars / 4 = 1.25 -> 2
      expect(estimateTokens("hello world")).toBe(3); // 11 chars / 4 = 2.75 -> 3
      expect(estimateTokens("a".repeat(100))).toBe(25);
    });
  });

  describe("createContextPackage", () => {
    it("should create package from messages", () => {
      const messages = [
        { role: "user", content: "Hello" },
        { role: "assistant", content: "Hi there!" },
      ];
      
      const pkg = createContextPackage(messages, 1000);
      
      expect(pkg.tokensSent).toBeGreaterThan(0);
      expect(pkg.tokensReceived).toBe(pkg.tokensSent);
      expect(pkg.truncated).toBe(false);
      expect(pkg.messages.length).toBe(2);
    });

    it("should truncate when exceeding max tokens", () => {
      const messages = [
        { role: "user", content: "a".repeat(1000) },
        { role: "assistant", content: "b".repeat(1000) },
        { role: "user", content: "c".repeat(1000) },
      ];
      
      const pkg = createContextPackage(messages, 500); // Low limit
      
      expect(pkg.truncated).toBe(true);
      expect(pkg.messages.length).toBeLessThan(3);
    });

    it("should include token counts per message", () => {
      const messages = [{ role: "user", content: "Hello world" }];
      const pkg = createContextPackage(messages);
      expect(pkg.messages[0].tokens).toBeGreaterThan(0);
    });
  });

  describe("calculateContextFill", () => {
    it("should calculate fill percentage correctly", () => {
      const result = calculateContextFill(50000, 100000);
      expect(result.fillPercent).toBe(50);
      expect(result.tokensAvailable).toBe(50000);
      expect(result.tokensUsed).toBe(50000);
    });

    it("should cap at 100%", () => {
      const result = calculateContextFill(150000, 100000);
      expect(result.fillPercent).toBe(100);
      expect(result.tokensAvailable).toBe(0);
    });

    it("should handle zero max tokens", () => {
      const result = calculateContextFill(100, 0);
      expect(result.fillPercent).toBe(0);
      expect(result.tokensAvailable).toBe(0);
    });
  });

  describe("diffContextPackages", () => {
    it("should detect differences between packages", () => {
      const sent = createContextPackage([
        { role: "user", content: "Message 1" },
        { role: "assistant", content: "Response 1" },
      ]);
      
      const received = createContextPackage([
        { role: "user", content: "Message 1" },
      ]);
      
      const diff = diffContextPackages(sent, received);
      const parsed = JSON.parse(diff);
      
      expect(parsed.sentOnly).toBeGreaterThanOrEqual(0);
      expect(parsed.receivedOnly).toBeGreaterThanOrEqual(0);
    });
  });
});

describe("Conversation Context", () => {
  beforeEach(() => {
    clearConversationContext("conv-test");
  });

  describe("getOrCreateConversationContext", () => {
    it("should create new context", () => {
      const ctx = getOrCreateConversationContext("conv-test", "session-1", "agent-1", "Test Agent");
      
      expect(ctx.conversationId).toBe("conv-test");
      expect(ctx.sessionId).toBe("session-1");
      expect(ctx.rootAgentId).toBe("agent-1");
      expect(ctx.rootAgentName).toBe("Test Agent");
      expect(ctx.agents).toBeInstanceOf(Map);
    });

    it("should return existing context", () => {
      const ctx1 = getOrCreateConversationContext("conv-test", "session-1", "agent-1", "Test Agent");
      const ctx2 = getOrCreateConversationContext("conv-test", "session-1", "agent-1", "Test Agent");
      
      expect(ctx1).toBe(ctx2);
    });
  });

  describe("getConversationContext", () => {
    it("should return undefined for non-existent context", () => {
      const ctx = getConversationContext("non-existent");
      expect(ctx).toBeUndefined();
    });

    it("should return existing context", () => {
      getOrCreateConversationContext("conv-test", "session-1", "agent-1", "Test Agent");
      const ctx = getConversationContext("conv-test");
      expect(ctx).toBeDefined();
    });
  });

  describe("clearConversationContext", () => {
    it("should remove context", () => {
      getOrCreateConversationContext("conv-test", "session-1", "agent-1", "Test Agent");
      clearConversationContext("conv-test");
      const ctx = getConversationContext("conv-test");
      expect(ctx).toBeUndefined();
    });
  });
});

describe("Agent Info", () => {
  describe("extractAgentInfo", () => {
    it("should create agent info with generated ID", () => {
      const info = extractAgentInfo("Test Agent", "session-123", "gpt-4", "openai", "A test agent", ["tool1", "tool2"]);
      
      expect(info.name).toBe("Test Agent");
      expect(info.model).toBe("gpt-4");
      expect(info.provider).toBe("openai");
      expect(info.description).toBe("A test agent");
      expect(info.tools).toEqual(["tool1", "tool2"]);
      expect(info.id).toMatch(/^agent_[a-f0-9]{12}$/);
      expect(info.version).toBeDefined();
    });

    it("should handle missing optional fields", () => {
      const info = extractAgentInfo("Test Agent", "session-123");
      
      expect(info.name).toBe("Test Agent");
      expect(info.model).toBeUndefined();
      expect(info.provider).toBeUndefined();
      expect(info.description).toBeUndefined();
      expect(info.tools).toEqual([]);
    });
  });
});