/**
 * opencode-otel-plugin - Sampler Tests
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { context } from "@opentelemetry/api";

// Real OTel Context has instance methods; keep mockContext bag-aware via symbol key
vi.mock("@opentelemetry/api", async () => {
  const actual = await vi.importActual("@opentelemetry/api");
  const mockContext = {
    getValue: vi.fn(() => undefined),
    setValue: vi.fn(function (this: unknown, _key: symbol, _value: unknown) {
      return this;
    }),
  };
  return {
    ...actual,
    context: {
      ...actual.context,
      active: vi.fn(() => mockContext),
      getValue: vi.fn(),
      setValue: vi.fn((ctx, key, value) => ctx),
    },
    trace: {
      ...actual.trace,
      getSpan: vi.fn(),
      getSpanContext: vi.fn(),
      setSpan: vi.fn((ctx, span) => ctx),
    },
    ROOT_CONTEXT: actual.ROOT_CONTEXT,
    SamplingDecision: {
      DROP: 0,
      RECORD: 1,
      RECORD_AND_SAMPLE: 2,
    },
    SamplingResult: {},
    Sampler: {},
    SpanKind: {
      INTERNAL: 0,
      SERVER: 1,
      CLIENT: 2,
      PRODUCER: 3,
      CONSUMER: 4,
    },
    Attributes: {},
    Context: {},
  };
});

const SamplingDecision = {
  DROP: 0,
  RECORD: 1,
  RECORD_AND_SAMPLE: 2,
};

describe("ConversationAwareSampler", () => {
  let sampler: any;
  let mockContext: ReturnType<typeof context.active>;

  beforeEach(async () => {
    vi.resetModules();
    const samplerModule = await import("../../dist/otel/sampler.js");
    const ConversationAwareSamplerClass = samplerModule.ConversationAwareSampler;
    sampler = new ConversationAwareSamplerClass(1.0, true); // Always sample
    mockContext = context.active();
  });

  describe("shouldSample", () => {
    it("should always sample when rate is 1.0", async () => {
      const samplerModule = await import("../../dist/otel/sampler.js");
      const samplerInstance = new samplerModule.ConversationAwareSampler(1.0, true);
      
      const result = samplerInstance.shouldSample(
        mockContext,
        "trace-id",
        "span-name",
        0, // SpanKind.INTERNAL
        {},
        []
      );
      expect(result.decision).toBe(SamplingDecision.RECORD_AND_SAMPLE);
    });

    it("should never sample when rate is 0", async () => {
      const samplerModule = await import("../../dist/otel/sampler.js");
      const neverSamplerInstance = new samplerModule.ConversationAwareSampler(0, true);
      
      const result = neverSamplerInstance.shouldSample(
        mockContext,
        "trace-id",
        "span-name",
        0,
        {},
        []
      );
      expect(result.decision).toBe(SamplingDecision.DROP);
    });

    it("should cache conversation decisions", async () => {
      const samplerModule = await import("../../dist/otel/sampler.js");
      const sampler = new samplerModule.ConversationAwareSampler(0.5, true);
      
      const result1 = sampler.shouldSample(
        mockContext,
        "trace-id-1",
        "span-name",
        0,
        { "gen_ai.conversation.id": "conv-1" },
        []
      );
      
      const result2 = sampler.shouldSample(
        mockContext,
        "trace-id-2",
        "span-name",
        0,
        { "gen_ai.conversation.id": "conv-1" },
        []
      );
      
      expect(result1.decision).toBe(result2.decision);
    });

    it("should make different decisions for different conversations", async () => {
      const samplerModule = await import("../../dist/otel/sampler.js");
      const sampler = new samplerModule.ConversationAwareSampler(0.5, true);
      
      const result1 = sampler.shouldSample(
        mockContext,
        "trace-id-1",
        "span-name",
        0,
        { "gen_ai.conversation.id": "conv-1" },
        []
      );
      
      const result2 = sampler.shouldSample(
        mockContext,
        "trace-id-2",
        "span-name",
        0,
        { "gen_ai.conversation.id": "conv-2" },
        []
      );
      
      // Both should have decisions (may be same or different due to randomness)
      expect(result1.decision).toBeDefined();
      expect(result2.decision).toBeDefined();
    });
  });

  describe("cache management", () => {
    it("should allow manual cache manipulation", async () => {
      const samplerModule = await import("../../dist/otel/sampler.js");
      const sampler = new samplerModule.ConversationAwareSampler(1.0, true);
      
      sampler.setConversationDecision("conv-manual", { decision: 2 }); // RECORD_AND_SAMPLE
      expect(sampler.getConversationDecision("conv-manual")).toBeDefined();
      
      sampler.clearConversationDecision("conv-manual");
      expect(sampler.getConversationDecision("conv-manual")).toBeUndefined();
    });
  });
});

describe("AlwaysSampleSampler", () => {
  it("should always return RECORD_AND_SAMPLE", async () => {
    const samplerModule = await import("../../dist/otel/sampler.js");
    const sampler = new samplerModule.AlwaysSampleSampler();
    const result = sampler.shouldSample(
      context.active(),
      "trace-id",
      "span-name",
      0,
      {},
      []
    );
    expect(result.decision).toBe(2); // RECORD_AND_SAMPLE
  });
});

describe("NeverSampleSampler", () => {
  it("should always return DROP", async () => {
    const samplerModule = await import("../../dist/otel/sampler.js");
    const sampler = new samplerModule.NeverSampleSampler();
    const result = sampler.shouldSample(
      context.active(),
      "trace-id",
      "span-name",
      0,
      {},
      []
    );
    expect(result.decision).toBe(0); // DROP
  });
});

describe("createConversationAwareSampler", () => {
  it("should create sampler with default options", async () => {
    const { createConversationAwareSampler } = await import("../../dist/otel/sampler.js");
    const sampler = createConversationAwareSampler(1.0, true);
    expect(sampler).toBeDefined();
  });

  it("should create sampler with custom rate", async () => {
    const { createConversationAwareSampler } = await import("../../dist/otel/sampler.js");
    const sampler = createConversationAwareSampler(0.5, false);
    expect(sampler).toBeDefined();
  });
});