/**
 * opencode-otel-plugin - Bounded Map Tests
 *
 * MAX_PENDING / setBoundedMap FIFO eviction (P0 memory-bounds gap).
 */

import { describe, it, expect } from "vitest";
import { MAX_PENDING, setBoundedMap, sweepMap } from "../../dist/utils/bounded.js";

describe("Bounded Map Helpers", () => {
  describe("MAX_PENDING", () => {
    it("should default to 500", () => {
      expect(MAX_PENDING).toBe(500);
    });
  });

  describe("setBoundedMap", () => {
    it("should insert without eviction under max", () => {
      const m = new Map<string, number>();
      const evicted = setBoundedMap(m, "a", 1, 3);
      expect(evicted).toBe(false);
      expect(m.get("a")).toBe(1);
      expect(m.size).toBe(1);
    });

    it("should evict oldest FIFO when over max", () => {
      const m = new Map<string, number>();
      setBoundedMap(m, "k1", 1, 2);
      setBoundedMap(m, "k2", 2, 2);
      const evicted = setBoundedMap(m, "k3", 3, 2);
      expect(evicted).toBe(true);
      expect(m.size).toBe(2);
      expect(m.has("k1")).toBe(false);
      expect(m.has("k2")).toBe(true);
      expect(m.has("k3")).toBe(true);
    });

    it("should use MAX_PENDING by default", () => {
      const m = new Map<number, number>();
      for (let i = 0; i < MAX_PENDING; i++) {
        setBoundedMap(m, i, i);
      }
      expect(m.size).toBe(MAX_PENDING);
      setBoundedMap(m, MAX_PENDING, 999);
      expect(m.size).toBe(MAX_PENDING);
      expect(m.has(0)).toBe(false);
      expect(m.has(MAX_PENDING)).toBe(true);
    });
  });

  describe("sweepMap", () => {
    it("should remove matching keys", () => {
      const m = new Map<string, string>([
        ["conv_a:root", "span1"],
        ["conv_b:root", "span2"],
        ["conv_a:tool:1", "span3"],
      ]);
      const removed = sweepMap(m, (k) => k.startsWith("conv_a"));
      expect(removed).toBe(2);
      expect(m.size).toBe(1);
      expect(m.has("conv_b:root")).toBe(true);
    });

    it("should return 0 when nothing matches", () => {
      const m = new Map([["x", 1]]);
      expect(sweepMap(m, () => false)).toBe(0);
      expect(m.size).toBe(1);
    });
  });
});
