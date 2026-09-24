/**
 * opencode-otel-plugin - Metrics Module Tests
 *
 * Tests GenAIMetrics helper and metric name constants (RESEARCH.md gap #2).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { GenAIMetrics, METRIC_NAMES, createMetricsSetup } from "../../dist/otel/metrics.js";
import { mergeConfig } from "../../dist/config.js";

// ─── Mock Meter ───────────────────────────────────────────────────────────────

function createMockMeter() {
  const counters: Record<string, { add: ReturnType<typeof vi.fn> }> = {};
  const histograms: Record<string, { record: ReturnType<typeof vi.fn> }> = {};

  return {
    counters,
    histograms,
    meter: {
      createCounter: vi.fn((name: string) => {
        counters[name] = { add: vi.fn() };
        return counters[name];
      }),
      createHistogram: vi.fn((name: string) => {
        histograms[name] = { record: vi.fn() };
        return histograms[name];
      }),
    },
  };
}

describe("Metrics Module", () => {
  describe("METRIC_NAMES", () => {
    it("should export GenAI metric names", () => {
      expect(METRIC_NAMES.TOKEN_USAGE_INPUT).toBe("gen_ai.client.token.usage");
      expect(METRIC_NAMES.INVOCATION_COUNT).toBe("gen_ai.client.invocation.count");
      expect(METRIC_NAMES.OPERATION_DURATION).toBe("gen_ai.client.operation.duration");
      expect(METRIC_NAMES.ERROR_COUNT).toBe("gen_ai.client.error.count");
    });
  });

  describe("GenAIMetrics", () => {
    let mock: ReturnType<typeof createMockMeter>;
    let metrics: GenAIMetrics;

    beforeEach(() => {
      mock = createMockMeter();
      metrics = new GenAIMetrics({ getMeter: vi.fn(() => mock.meter) });
    });

    it("should create meter named opencode-otel-plugin", () => {
      const provider = { getMeter: vi.fn(() => mock.meter) };
      new GenAIMetrics(provider);
      expect(provider.getMeter).toHaveBeenCalledWith("opencode-otel-plugin");
    });

    it("should create counters and histogram on init", () => {
      expect(mock.meter.createCounter).toHaveBeenCalledWith(
        "gen_ai.client.token.usage.input",
        expect.any(Object)
      );
      expect(mock.meter.createCounter).toHaveBeenCalledWith(
        "gen_ai.client.token.usage.output",
        expect.any(Object)
      );
      expect(mock.meter.createCounter).toHaveBeenCalledWith(
        "gen_ai.client.invocation.count",
        expect.any(Object)
      );
      expect(mock.meter.createHistogram).toHaveBeenCalledWith(
        "gen_ai.client.operation.duration",
        expect.any(Object)
      );
      expect(mock.meter.createCounter).toHaveBeenCalledWith(
        "gen_ai.client.error.count",
        expect.any(Object)
      );
    });

    it("recordTokenUsage should add to input and output counters", () => {
      metrics.recordTokenUsage(100, 50, { model: "gpt-4" });
      expect(mock.counters["gen_ai.client.token.usage.input"].add).toHaveBeenCalledWith(
        100,
        { model: "gpt-4" }
      );
      expect(mock.counters["gen_ai.client.token.usage.output"].add).toHaveBeenCalledWith(
        50,
        { model: "gpt-4" }
      );
    });

    it("recordTokenUsage should default attributes to empty object", () => {
      metrics.recordTokenUsage(10, 5);
      expect(mock.counters["gen_ai.client.token.usage.input"].add).toHaveBeenCalledWith(
        10,
        {}
      );
    });

    it("recordInvocation should add 1", () => {
      metrics.recordInvocation({ operation: "chat" });
      expect(mock.counters["gen_ai.client.invocation.count"].add).toHaveBeenCalledWith(
        1,
        { operation: "chat" }
      );
    });

    it("recordDuration should record histogram value", () => {
      metrics.recordDuration(123.4, { operation: "chat" });
      expect(mock.histograms["gen_ai.client.operation.duration"].record).toHaveBeenCalledWith(
        123.4,
        { operation: "chat" }
      );
    });

    it("recordError should add 1 to error counter", () => {
      metrics.recordError({ "error.type": "Error" });
      expect(mock.counters["gen_ai.client.error.count"].add).toHaveBeenCalledWith(
        1,
        { "error.type": "Error" }
      );
    });

    // ─── Official catalog (15 instruments) ──────────────────────────────────

    it("should create official catalog instruments", () => {
      const expectedCounters = [
        "session.count",
        "cost.usage",
        "lines_of_code.count",
        "lines_of_code.total",
        "commit.count",
        "cache.count",
        "message.count",
        "model.usage",
        "retry.count",
        "subtask.count",
      ];
      for (const name of expectedCounters) {
        expect(mock.meter.createCounter).toHaveBeenCalledWith(name, expect.any(Object));
      }
      const expectedHistograms = [
        "tool.duration",
        "session.duration",
        "session.token.total",
        "session.cost.total",
      ];
      for (const name of expectedHistograms) {
        expect(mock.meter.createHistogram).toHaveBeenCalledWith(name, expect.any(Object));
      }
      // total token usage counter (semconv name, kept for TOKEN_USAGE_INPUT compat)
      expect(mock.meter.createCounter).toHaveBeenCalledWith(
        "gen_ai.client.token.usage",
        expect.any(Object)
      );
    });

    it("recordSessionCount / recordCommit / recordSubtask should add 1", () => {
      metrics.recordSessionCount({ "gen_ai.session.id": "s1" });
      expect(mock.counters["session.count"].add).toHaveBeenCalledWith(1, { "gen_ai.session.id": "s1" });
      metrics.recordCommit();
      expect(mock.counters["commit.count"].add).toHaveBeenCalledWith(1, {});
      metrics.recordSubtask({ to: "explore" });
      expect(mock.counters["subtask.count"].add).toHaveBeenCalledWith(1, { to: "explore" });
    });

    it("recordLinesOfCode should update count and total", () => {
      metrics.recordLinesOfCode(10, 2, { "file.operation": "edit" });
      expect(mock.counters["lines_of_code.count"].add).toHaveBeenCalledWith(1, {
        "file.operation": "edit",
        "file.lines_added": 10,
        "file.lines_removed": 2,
      });
      expect(mock.counters["lines_of_code.total"].add).toHaveBeenCalledWith(12, {
        "file.operation": "edit",
      });
    });

    it("recordToolDuration / recordSessionDuration should record histograms", () => {
      metrics.recordToolDuration(42, { tool: "bash" });
      expect(mock.histograms["tool.duration"].record).toHaveBeenCalledWith(42, { tool: "bash" });
      metrics.recordSessionDuration(1000, { reason: "idle" });
      expect(mock.histograms["session.duration"].record).toHaveBeenCalledWith(1000, { reason: "idle" });
    });

    it("should respect disabledMetrics", () => {
      const m2 = new GenAIMetrics(
        { getMeter: vi.fn(() => mock.meter) },
        { disabledMetrics: ["session.count"] }
      );
      // session.count instrument should not be created again (already created above without disable);
      // construct fresh mock
      const fresh = createMockMeter();
      new GenAIMetrics({ getMeter: vi.fn(() => fresh.meter) }, { disabledMetrics: ["session.count"] });
      expect(fresh.meter.createCounter).not.toHaveBeenCalledWith(
        "session.count",
        expect.any(Object)
      );
      expect(m2).toBeDefined();
    });

    it("should apply metricPrefix", () => {
      const fresh = createMockMeter();
      new GenAIMetrics({ getMeter: vi.fn(() => fresh.meter) }, { metricPrefix: "myapp." });
      expect(fresh.meter.createCounter).toHaveBeenCalledWith(
        "myapp.session.count",
        expect.any(Object)
      );
    });
  });

  describe("createMetricsSetup", () => {
    it("succeeds with default batch config (interval >= timeout)", async () => {
      // Regression: PeriodicExportingMetricReader requires exportIntervalMillis >= exportTimeoutMillis.
      // Defaults are scheduledDelay=5000 / exportTimeout=30000 and previously failed setup.
      const config = mergeConfig({
        endpoint: "http://127.0.0.1:4318/v1/traces",
      });
      const setup = await createMetricsSetup(config);
      expect(setup).not.toBeNull();
      expect(typeof setup!.forceFlush).toBe("function");
      await setup!.shutdown();
    });
  });
});
