/**
 * opencode-otel-plugin - Context Window Utility Tests
 */

import { describe, it, expect } from "vitest";
import {
  estimateTokens,
  createContextPackage,
  calculateContextFill,
  calculateContextFidelity,
  diffContextPackages,
  createContextSnapshot,
} from "../../dist/utils/context.js";

describe("Context Utilities", () => {
  describe("estimateTokens", () => {
    it("should estimate ~4 chars per token", () => {
      expect(estimateTokens("")).toBe(0);
      expect(estimateTokens("abcd")).toBe(1);
      expect(estimateTokens("abcdefgh")).toBe(2);
    });

    it("should round up partial tokens", () => {
      expect(estimateTokens("abcde")).toBe(2);
    });
  });

  describe("createContextPackage", () => {
    it("should package all messages when under limit", () => {
      const pkg = createContextPackage([
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ], 1000);

      expect(pkg.messages).toHaveLength(2);
      expect(pkg.truncated).toBe(false);
      expect(pkg.tokensSent).toBeGreaterThan(0);
      expect(pkg.messages[0].role).toBe("user");
      expect(pkg.messages[1].role).toBe("assistant");
    });

    it("should truncate oldest messages when over limit", () => {
      const messages = Array.from({ length: 50 }, (_, i) => ({
        role: "user",
        content: `message ${i} `.repeat(10),
      }));
      const pkg = createContextPackage(messages, 50);

      expect(pkg.truncated).toBe(true);
      expect(pkg.messages.length).toBeLessThan(messages.length);
      // Most recent messages retained (processes reverse)
      const last = pkg.messages[pkg.messages.length - 1];
      expect(last.content).toContain("message 49");
    });

    it("should return empty package for no messages", () => {
      const pkg = createContextPackage([], 100);
      expect(pkg.messages).toHaveLength(0);
      expect(pkg.tokensSent).toBe(0);
      expect(pkg.truncated).toBe(false);
    });
  });

  describe("calculateContextFill", () => {
    it("should compute fill percentage", () => {
      const result = calculateContextFill(500, 1000);
      expect(result.fillPercent).toBe(50);
      expect(result.tokensAvailable).toBe(500);
      expect(result.tokensUsed).toBe(500);
    });

    it("should clamp to 0-100", () => {
      expect(calculateContextFill(2000, 1000).fillPercent).toBe(100);
      expect(calculateContextFill(-10, 1000).fillPercent).toBe(0);
    });

    it("should handle zero maxTokens", () => {
      expect(calculateContextFill(100, 0).fillPercent).toBe(0);
    });
  });

  describe("calculateContextFidelity", () => {
    it("should return 1 when no drop", () => {
      const r = calculateContextFidelity(100, 100);
      expect(r.fidelity).toBe(1);
      expect(r.fidelityPercent).toBe(100);
      expect(r.tokensDropped).toBe(0);
    });

    it("should compute dropped tokens", () => {
      const r = calculateContextFidelity(100, 80);
      expect(r.fidelity).toBeCloseTo(0.8);
      expect(r.fidelityPercent).toBe(80);
      expect(r.tokensDropped).toBe(20);
    });

    it("should return fidelity 1 for zero sent", () => {
      expect(calculateContextFidelity(0, 0).fidelity).toBe(1);
    });
  });

  describe("diffContextPackages", () => {
    it("should return JSON with sent/received counts", () => {
      const a = createContextPackage([{ role: "user", content: "one" }], 1000);
      const b = createContextPackage([{ role: "user", content: "two" }], 1000);
      const diff = JSON.parse(diffContextPackages(a, b));
      expect(diff.sentOnly).toBe(1);
      expect(diff.receivedOnly).toBe(1);
      expect(typeof diff.sentTokens).toBe("number");
    });

    it("should return zero diffs for identical packages", () => {
      const msgs = [{ role: "user", content: "same" }];
      const a = createContextPackage(msgs, 1000);
      const b = createContextPackage(msgs, 1000);
      const diff = JSON.parse(diffContextPackages(a, b));
      expect(diff.sentOnly).toBe(0);
      expect(diff.receivedOnly).toBe(0);
    });
  });

  describe("createContextSnapshot", () => {
    it("should create snapshot with fill metrics", () => {
      const snap = createContextSnapshot(700, 1000);
      expect(snap.fillPercent).toBe(70);
      expect(snap.maxTokens).toBe(1000);
      expect(snap.fidelity).toBe(1);
      expect(snap.alert).toBe(false);
      expect(snap.threshold).toBe(0.7);
    });

    it("should alert when fidelity below threshold", () => {
      const snap = createContextSnapshot(100, 1000, {
        tokensSent: 100,
        tokensReceived: 50,
        threshold: 0.7,
      });
      expect(snap.alert).toBe(true);
      expect(snap.fidelityPercent).toBe(50);
      expect(snap.tokensDropped).toBe(50);
    });

    it("should not alert when fidelity above threshold", () => {
      const snap = createContextSnapshot(100, 1000, {
        tokensSent: 100,
        tokensReceived: 95,
      });
      expect(snap.alert).toBe(false);
      expect(snap.fidelityPercent).toBe(95);
    });
  });
});
