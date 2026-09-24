/**
 * opencode-otel-plugin - Configuration Tests
 */

import { describe, it, expect } from "vitest";
import { mergeConfig, validateConfig, defaults } from "../../dist/config.js";

describe("Configuration", () => {
  describe("mergeConfig", () => {
    it("should return defaults when no options provided", () => {
      const config = mergeConfig();
      
      expect(config.endpoint).toBe(defaults.DEFAULT_ENDPOINT);
      expect(config.protocol).toBe(defaults.DEFAULT_PROTOCOL);
      expect(config.serviceName).toBe(defaults.DEFAULT_SERVICE_NAME);
      expect(config.environment).toBe(defaults.DEFAULT_ENVIRONMENT);
      expect(config.batch).toEqual(defaults.DEFAULT_BATCH);
      expect(config.sampling).toEqual(defaults.DEFAULT_SAMPLING);
      expect(config.piiRedaction.enabled).toBe(true);
      expect(config.debug).toBe(false);
    });

    it("should override defaults with provided options", () => {
      const config = mergeConfig({
        endpoint: "http://custom:4318/v1/traces",
        protocol: "grpc",
        serviceName: "my-service",
        environment: "production",
        debug: true,
      });
      
      expect(config.endpoint).toBe("http://custom:4318/v1/traces");
      expect(config.protocol).toBe("grpc");
      expect(config.serviceName).toBe("my-service");
      expect(config.environment).toBe("production");
      expect(config.debug).toBe(true);
    });

    it("should merge batch config", () => {
      const config = mergeConfig({
        batch: {
          maxQueueSize: 4096,
          scheduledDelayMillis: 10000,
        },
      });
      
      expect(config.batch.maxQueueSize).toBe(4096);
      expect(config.batch.scheduledDelayMillis).toBe(10000);
      expect(config.batch.maxExportBatchSize).toBe(defaults.DEFAULT_BATCH.maxExportBatchSize);
    });

    it("should merge sampling config", () => {
      const config = mergeConfig({
        sampling: {
          rate: 0.5,
          conversationAware: false,
        },
      });
      
      expect(config.sampling.rate).toBe(0.5);
      expect(config.sampling.conversationAware).toBe(false);
      expect(config.sampling.parentBased).toBe(true);
    });

    it("should merge PII redaction config", () => {
      const config = mergeConfig({
        piiRedaction: {
          enabled: false,
          patterns: [/custom-pattern/],
          defaultFields: ["customField"],
        },
      });
      
      expect(config.piiRedaction.enabled).toBe(false);
      expect(config.piiRedaction.patterns).toContainEqual(/custom-pattern/);
      expect(config.piiRedaction.defaultFields).toContain("customField");
      // Should still include default fields
      expect(config.piiRedaction.defaultFields).toContain("apiKey");
    });

    it("should merge resource attributes", () => {
      const config = mergeConfig({
        resourceAttributes: {
          "deployment.region": "us-east-1",
          "team": "platform",
        },
      });
      
      expect(config.resourceAttributes["deployment.region"]).toBe("us-east-1");
      expect(config.resourceAttributes["team"]).toBe("platform");
    });

    it("should merge headers", () => {
      const config = mergeConfig({
        headers: {
          "Authorization": "Bearer token123",
        },
      });
      
      expect(config.headers["Authorization"]).toBe("Bearer token123");
    });

    it("should merge persistence config with defaults", () => {
      const config = mergeConfig({
        persistence: { enabled: true, maxSpans: 500 },
      });
      expect(config.persistence.enabled).toBe(true);
      expect(config.persistence.maxSpans).toBe(500);
      expect(config.persistence.directory).toBe(defaults.DEFAULT_PERSISTENCE.directory);
      expect(config.persistence.maxInMemory).toBe(defaults.DEFAULT_PERSISTENCE.maxInMemory);
    });

    it("should default persistence to disabled", () => {
      const config = mergeConfig();
      expect(config.persistence.enabled).toBe(false);
    });
  });

  describe("validateConfig", () => {
    it("should not throw for valid config", () => {
      const config = mergeConfig();
      expect(() => validateConfig(config)).not.toThrow();
    });

    it("should throw for missing endpoint", () => {
      const config = mergeConfig({ endpoint: "" });
      expect(() => validateConfig(config)).toThrow("endpoint is required");
    });

    it("should throw for invalid endpoint URL", () => {
      const config = mergeConfig({ endpoint: "not-a-url" });
      expect(() => validateConfig(config)).toThrow("invalid endpoint URL");
    });

    it("should throw for invalid protocol", () => {
      const config = mergeConfig({ protocol: "invalid" as any });
      expect(() => validateConfig(config)).toThrow("protocol must be one of");
    });

    it("should accept http/protobuf and http/json protocols", () => {
      expect(() => validateConfig(mergeConfig({ protocol: "http/protobuf" as any }))).not.toThrow();
      expect(() => validateConfig(mergeConfig({ protocol: "http/json" as any }))).not.toThrow();
    });

    it("should validate traceparent format", () => {
      const bad = mergeConfig({ traceparent: "not-a-traceparent" });
      expect(() => validateConfig(bad)).toThrow("traceparent");
      const good = mergeConfig({ traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01" });
      expect(() => validateConfig(good)).not.toThrow();
    });

    it("should throw for missing serviceName", () => {
      const config = mergeConfig({ serviceName: "" });
      expect(() => validateConfig(config)).toThrow("serviceName is required");
    });

    it("should throw for invalid batch config", () => {
      const config = mergeConfig({ batch: { maxQueueSize: 0 } });
      expect(() => validateConfig(config)).toThrow("maxQueueSize must be > 0");
    });

    it("should throw when maxExportBatchSize > maxQueueSize", () => {
      const config = mergeConfig({ 
        batch: { 
          maxQueueSize: 100,
          maxExportBatchSize: 200,
        } 
      });
      expect(() => validateConfig(config)).toThrow("maxExportBatchSize must not exceed maxQueueSize");
    });

    it("should throw for invalid sampling rate", () => {
      const config = mergeConfig({ sampling: { rate: 1.5 } });
      expect(() => validateConfig(config)).toThrow("sampling.rate must be between 0 and 1");
    });

    it("should throw for invalid PII patterns", () => {
      const config = mergeConfig({ piiRedaction: { patterns: ["not-a-regex"] as any } });
      expect(() => validateConfig(config)).toThrow("patterns must be RegExp instances");
    });

    it("should throw for invalid persistence.maxInMemory", () => {
      const config = mergeConfig({ persistence: { maxInMemory: 0 } });
      expect(() => validateConfig(config)).toThrow("persistence.maxInMemory must be > 0");
    });

    it("should throw for invalid persistence.maxSpans", () => {
      const config = mergeConfig({ persistence: { maxSpans: -1 } });
      expect(() => validateConfig(config)).toThrow("persistence.maxSpans must be > 0");
    });

    it("should throw when persistence.maxSpans < maxInMemory", () => {
      const config = mergeConfig({
        persistence: { maxInMemory: 100, maxSpans: 50 },
      });
      expect(() => validateConfig(config)).toThrow("maxSpans must be >= persistence.maxInMemory");
    });

    it("should throw for non-string serviceVersion", () => {
      const config = mergeConfig({ serviceVersion: 123 as any });
      expect(() => validateConfig(config)).toThrow("serviceVersion must be a string");
    });

    it("should throw for empty serviceVersion", () => {
      const config = mergeConfig({ serviceVersion: "" });
      expect(() => validateConfig(config)).toThrow("serviceVersion must not be empty");
    });

    it("should throw for empty environment", () => {
      const config = mergeConfig({ environment: "" });
      expect(() => validateConfig(config)).toThrow("environment must not be empty");
    });

    it("should throw for non-http endpoint scheme with http protocol", () => {
      const config = mergeConfig({ endpoint: "ftp://example.com/v1/traces", protocol: "http" });
      expect(() => validateConfig(config)).toThrow("requires an http/https endpoint");
    });

    it("should throw when http endpoint targets gRPC port 4317", () => {
      const config = mergeConfig({ endpoint: "http://localhost:4317/v1/traces", protocol: "http" });
      expect(() => validateConfig(config)).toThrow("gRPC port 4317");
    });

    it("should throw for header value with CR/LF (injection)", () => {
      const config = mergeConfig({
        headers: { Authorization: "Bearer ok\r\nX-Injected: yes" },
      });
      expect(() => validateConfig(config)).toThrow("must not contain CR/LF");
    });

    it("should throw for non-string header value", () => {
      const config = mergeConfig({ headers: { Authorization: 123 as any } });
      expect(() => validateConfig(config)).toThrow("must be a string");
    });

    it("should throw for non-string resourceAttributes value", () => {
      const config = mergeConfig({ resourceAttributes: { team: 42 as any } });
      expect(() => validateConfig(config)).toThrow("resourceAttributes value for 'team' must be a string");
    });

    it("should throw for resourceAttributes key with whitespace", () => {
      const config = mergeConfig({ resourceAttributes: { "bad key": "v" } });
      expect(() => validateConfig(config)).toThrow("must not contain whitespace");
    });

    it("should accept valid headers and resourceAttributes", () => {
      const config = mergeConfig({
        headers: { Authorization: "Bearer token" },
        resourceAttributes: { "deployment.region": "us-east-1" },
        serviceVersion: "1.2.3",
        environment: "production",
      });
      expect(() => validateConfig(config)).not.toThrow();
    });
  });
});