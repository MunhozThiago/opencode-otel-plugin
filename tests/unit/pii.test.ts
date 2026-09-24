/**
 * opencode-otel-plugin - PII Redaction Tests
 */

import { describe, it, expect, beforeEach } from "vitest";
import { createPIIRedactor, hashMemoryKey, DEFAULT_PATTERNS, SENSITIVE_FIELDS } from "../../dist/utils/pii.js";

describe("PII Redaction", () => {
  let redactor: ReturnType<typeof createPIIRedactor>;

  beforeEach(() => {
    redactor = createPIIRedactor({
      enabled: true,
      rules: [],
      defaultFields: ["apiKey", "password", "secret", "token", "authorization"],
    });
  });

  describe("redactString", () => {
    it("should redact API keys", () => {
      const input = 'apiKey: "sk-1234567890abcdef1234567890abcdef"';
      const result = redactor.redactString(input);
      expect(result).toContain("[REDACTED_API_KEY]");
      expect(result).not.toContain("sk-1234567890abcdef1234567890abcdef");
    });

    it("should redact bearer tokens", () => {
      const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
      const result = redactor.redactString(input);
      expect(result).toContain("[REDACTED_TOKEN]");
    });

    it("should redact AWS keys", () => {
      const input = 'AKIAIOSFODNN7EXAMPLE';
      const result = redactor.redactString(input);
      expect(result).toBe("[REDACTED_AWS_KEY]");
    });

    it("should redact GitHub tokens", () => {
      const input = 'ghp_1234567890abcdef1234567890abcdef1234';
      const result = redactor.redactString(input);
      expect(result).toBe("[REDACTED_GITHUB_TOKEN]");
    });

    it("should redact JWT tokens", () => {
      const input = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      const result = redactor.redactString(input);
      expect(result).toBe("[REDACTED_JWT]");
    });

    it("should redact private keys", () => {
      const input = `-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC...\n-----END PRIVATE KEY-----`;
      const result = redactor.redactString(input);
      expect(result).toBe("[REDACTED_PRIVATE_KEY]");
    });

    it("should redact database URLs with credentials", () => {
      const input = 'mongodb://user:password@localhost:27017/db';
      const result = redactor.redactString(input);
      // The pattern redacts the password but keeps the rest of the URL
      expect(result).toBe("mongodb://user:[REDACTED]@localhost:27017/db");
    });

    it("should redact credit card numbers", () => {
      const input = '4111 1111 1111 1111';
      const result = redactor.redactString(input);
      expect(result).toBe("[REDACTED_CC]");
    });

    it("should redact SSN", () => {
      const input = '123-45-6789';
      const result = redactor.redactString(input);
      expect(result).toBe("[REDACTED_SSN]");
    });

    it("should not redact when disabled", () => {
      redactor.updateConfig({ enabled: false });
      const input = 'apiKey: "sk-1234567890abcdef1234567890abcdef"';
      const result = redactor.redactString(input);
      expect(result).toBe(input);
    });
  });

  describe("redactValue", () => {
    it("should redact string values", () => {
      const result = redactor.redactValue('password: "secret123"');
      expect(result).toContain("[REDACTED_SECRET]");
    });

    it("should redact sensitive fields by name", () => {
      const result = redactor.redactValue("my-secret-value", "apiKey");
      expect(result).toBe("[REDACTED]");
    });

    it("should redact nested objects", () => {
      const input = {
        config: {
          apiKey: "sk-1234567890abcdef1234567890abcdef",
          normalField: "value",
        },
      };
      const result = redactor.redactValue(input);
      expect(result.config.apiKey).toBe("[REDACTED]");
      expect(result.config.normalField).toBe("value");
    });

    it("should redact arrays", () => {
      const input = [
        'apiKey: "sk-1234567890abcdef1234567890abcdef"',
        "normal string",
      ];
      const result = redactor.redactValue(input);
      expect(result[0]).toContain("[REDACTED_API_KEY]");
      expect(result[1]).toBe("normal string");
    });

    it("should not redact numbers, booleans, null", () => {
      expect(redactor.redactValue(123)).toBe(123);
      expect(redactor.redactValue(true)).toBe(true);
      expect(redactor.redactValue(null)).toBe(null);
      expect(redactor.redactValue(undefined)).toBe(undefined);
    });
  });

  describe("redactAttributes", () => {
    it("should redact all values in attributes object", () => {
      const attributes = {
        "gen_ai.agent.id": "agent_123",
        "gen_ai.request.model": "gpt-4",
        "apiKey": "sk-1234567890abcdef1234567890abcdef",
        "normal_field": "value",
      };
      const result = redactor.redactAttributes(attributes);
      expect(result["gen_ai.agent.id"]).toBe("agent_123");
      expect(result["gen_ai.request.model"]).toBe("gpt-4");
      expect(result["apiKey"]).toBe("[REDACTED]");
      expect(result["normal_field"]).toBe("value");
    });
  });

  describe("hashMemoryKey", () => {
    it("should produce consistent hash for same key", () => {
      const hash1 = hashMemoryKey("my-secret-key");
      const hash2 = hashMemoryKey("my-secret-key");
      expect(hash1).toBe(hash2);
    });

    it("should produce different hashes for different keys", () => {
      const hash1 = hashMemoryKey("key1");
      const hash2 = hashMemoryKey("key2");
      expect(hash1).not.toBe(hash2);
    });

    it("should prefix with mem_", () => {
      const hash = hashMemoryKey("test");
      expect(hash).toMatch(/^mem_[a-f0-9]{8}$/);
    });
  });

  describe("DEFAULT_PATTERNS", () => {
    it("should have default patterns defined", () => {
      expect(DEFAULT_PATTERNS.length).toBeGreaterThan(0);
      expect(DEFAULT_PATTERNS.every(p => p.pattern instanceof RegExp)).toBe(true);
      expect(DEFAULT_PATTERNS.every(p => typeof p.replacement === "string" || typeof p.replacement === "function")).toBe(true);
    });
  });

  describe("SENSITIVE_FIELDS", () => {
    it("should contain common sensitive field names", () => {
      expect(SENSITIVE_FIELDS.has("apiKey")).toBe(true);
      expect(SENSITIVE_FIELDS.has("password")).toBe(true);
      expect(SENSITIVE_FIELDS.has("secret")).toBe(true);
      expect(SENSITIVE_FIELDS.has("token")).toBe(true);
      expect(SENSITIVE_FIELDS.has("authorization")).toBe(true);
    });
  });
});