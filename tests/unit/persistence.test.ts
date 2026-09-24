/**
 * opencode-otel-plugin - Persistence Layer Tests
 *
 * Tests local span persistence (RESEARCH.md gap #9).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LocalSpanStore,
  PersistenceSpanProcessor,
  createLocalSpanStore,
  createPersistenceProcessor,
  type PersistedSpan,
} from "../../dist/otel/persistence.js";

const TRACE_ID = "0123456789abcdef0123456789abcdef";
const SPAN_ID = "0123456789abcdef";

function makeSpan(overrides: Partial<PersistedSpan> = {}): PersistedSpan {
  return {
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    name: "test-span",
    kind: 2,
    startTimeUnixNano: "1700000000000000000",
    endTimeUnixNano: "1700000001000000000",
    status: { code: 1 },
    attributes: { "session.id": "s1" },
    persistedAt: Date.now(),
    ...overrides,
  };
}

function makeReadableSpan(name = "chat.primary"): any {
  return {
    name,
    kind: 2,
    parentSpanId: "aaaaaaaaaaaaaaaa",
    startTime: [1700000000, 0],
    endTime: [1700000001, 500000000],
    status: { code: 1, message: "" },
    attributes: { "gen_ai.operation.name": "chat", "gen_ai.token_usage.input": 10 },
    spanContext: () => ({
      traceId: TRACE_ID,
      spanId: SPAN_ID,
      traceFlags: 1,
    }),
  };
}

describe("Persistence Layer", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "otel-persist-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("LocalSpanStore", () => {
    it("is a no-op when disabled", () => {
      const store = createLocalSpanStore({ enabled: false });
      expect(store.isEnabled).toBe(false);
      store.record(makeSpan());
      expect(store.size()).toBe(0);
      expect(store.load()).toHaveLength(0);
    });

    it("queues spans in memory when enabled", () => {
      const store = createLocalSpanStore({ enabled: true, directory: dir });
      store.record(makeSpan());
      store.record(makeSpan({ spanId: "ffffffffffffffff" }));
      expect(store.size()).toBe(2);
      const loaded = store.load();
      expect(loaded).toHaveLength(2);
      expect(loaded[0].traceId).toBe(TRACE_ID);
    });

    it("spills to disk when in-memory limit exceeded", () => {
      const store = createLocalSpanStore({
        enabled: true,
        directory: dir,
        maxInMemory: 2,
        maxSpans: 100,
      });
      for (let i = 0; i < 5; i++) {
        store.record(makeSpan({ spanId: i.toString(16).padStart(16, "0") }));
      }
      const stats = store.stats();
      expect(stats.inMemory).toBeLessThanOrEqual(2);
      expect(stats.onDisk).toBeGreaterThanOrEqual(2);
      expect(existsSync(join(dir, "spans.jsonl"))).toBe(true);
      // load merges disk + memory
      expect(store.load().length).toBe(store.size());
    });

    it("persists ReadableSpan with attribute extraction", () => {
      const store = createLocalSpanStore({ enabled: true, directory: dir, maxInMemory: 1 });
      store.record(makeReadableSpan());
      // Force spill by exceeding maxInMemory
      store.record(makeReadableSpan("second"));
      store.record(makeReadableSpan("third"));

      const all = store.load();
      expect(all.length).toBeGreaterThanOrEqual(1);
      const withAttr = all.find((s) => s.attributes["gen_ai.operation.name"] === "chat");
      expect(withAttr).toBeDefined();
      expect(withAttr!.attributes["gen_ai.token_usage.input"]).toBe(10);
      expect(withAttr!.startTimeUnixNano).toBe("1700000000000000000");
      expect(withAttr!.endTimeUnixNano).toBe("1700000001500000000");
    });

    it("clear() empties memory and disk file", () => {
      const store = createLocalSpanStore({
        enabled: true,
        directory: dir,
        maxInMemory: 1,
      });
      store.record(makeSpan());
      store.record(makeSpan({ spanId: "bbbbbbbbbbbbbbbb" }));
      store.clear();
      expect(store.size()).toBe(0);
      expect(store.load()).toHaveLength(0);
      const file = join(dir, "spans.jsonl");
      if (existsSync(file)) {
        expect(readFileSync(file, "utf8").trim()).toBe("");
      }
    });

    it("enforces maxSpans by dropping oldest", () => {
      const store = createLocalSpanStore({
        enabled: true,
        directory: dir,
        maxInMemory: 3,
        maxSpans: 5,
      });
      for (let i = 0; i < 10; i++) {
        store.record(makeSpan({ spanId: i.toString(16).padStart(16, "0") }));
      }
      expect(store.size()).toBeLessThanOrEqual(5);
      expect(store.stats().dropped).toBeGreaterThan(0);
    });

    it("ignores spans without trace/span ids", () => {
      const store = createLocalSpanStore({ enabled: true, directory: dir });
      store.record(makeSpan({ traceId: "", spanId: "" }));
      expect(store.size()).toBe(0);
    });
  });

  describe("PersistenceSpanProcessor", () => {
    it("records spans on end", () => {
      const store = createLocalSpanStore({ enabled: true, directory: dir });
      const processor = new PersistenceSpanProcessor(store);
      processor.onStart({} as any, {} as any);
      processor.onEnd(makeReadableSpan());
      expect(store.size()).toBeGreaterThanOrEqual(1);
    });

    it("shutdown and forceFlush resolve", async () => {
      const store = createLocalSpanStore({ enabled: true, directory: dir });
      const processor = new PersistenceSpanProcessor(store);
      await expect(processor.shutdown()).resolves.toBeUndefined();
      await expect(processor.forceFlush()).resolves.toBeUndefined();
    });
  });

  describe("createPersistenceProcessor", () => {
    it("returns null when disabled", () => {
      expect(createPersistenceProcessor({ enabled: false })).toBeNull();
    });

    it("returns store and processor when enabled", () => {
      const result = createPersistenceProcessor({ enabled: true, directory: dir });
      expect(result).not.toBeNull();
      expect(result!.store.isEnabled).toBe(true);
      expect(result!.processor).toBeInstanceOf(PersistenceSpanProcessor);
    });
  });
});
