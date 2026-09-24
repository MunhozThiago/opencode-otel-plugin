/**
 * opencode-otel-plugin - Exporter Endpoint Helper Tests
 */

import { describe, it, expect } from "vitest";
import {
  getMetricsEndpoint,
  getLogsEndpoint,
  getBaseEndpoint,
  buildHttpSignalUrl,
} from "../../dist/otel/exporter.js";

describe("Exporter Endpoint Helpers", () => {
  describe("getMetricsEndpoint", () => {
    it("should replace /v1/traces with /v1/metrics", () => {
      expect(getMetricsEndpoint("http://localhost:4318/v1/traces")).toBe(
        "http://localhost:4318/v1/metrics"
      );
    });

    it("should append /v1/metrics when no signal path present", () => {
      expect(getMetricsEndpoint("http://localhost:4318")).toBe(
        "http://localhost:4318/v1/metrics"
      );
    });
  });

  describe("getLogsEndpoint", () => {
    it("should replace /v1/traces with /v1/logs", () => {
      expect(getLogsEndpoint("http://localhost:4318/v1/traces")).toBe(
        "http://localhost:4318/v1/logs"
      );
    });
  });

  describe("buildHttpSignalUrl", () => {
    it("should build metrics URL from bare base", () => {
      expect(buildHttpSignalUrl("http://collector:4318", "metrics")).toBe(
        "http://collector:4318/v1/metrics"
      );
    });

    it("should rebuild from existing traces path", () => {
      expect(buildHttpSignalUrl("http://collector:4318/v1/traces", "logs")).toBe(
        "http://collector:4318/v1/logs"
      );
    });

    it("should preserve trailing-slash-free base", () => {
      expect(buildHttpSignalUrl("http://collector:4318/", "traces")).toBe(
        "http://collector:4318/v1/traces"
      );
    });
  });

  describe("getBaseEndpoint", () => {
    it("should strip /v1/traces for grpc", () => {
      expect(getBaseEndpoint("http://localhost:4317/v1/traces", "grpc")).toBe(
        "http://localhost:4317"
      );
    });

    it("should return full endpoint for http", () => {
      expect(
        getBaseEndpoint("http://localhost:4318/v1/traces", "http")
      ).toBe("http://localhost:4318/v1/traces");
    });
  });
});
