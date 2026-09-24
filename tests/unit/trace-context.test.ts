/**
 * opencode-otel-plugin - Remote Parent Trace Context Tests
 */

import { describe, it, expect } from "vitest";
import {
  remoteParentContext,
  resolveRootContext,
} from "../../dist/otel/trace-context.js";
import { trace, ROOT_CONTEXT } from "@opentelemetry/api";

const VALID_TP = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01";

describe("Remote Parent Trace Context", () => {
  describe("remoteParentContext", () => {
    it("should return null for missing/invalid traceparent", () => {
      expect(remoteParentContext(undefined)).toBeNull();
      expect(remoteParentContext("")).toBeNull();
      expect(remoteParentContext("garbage")).toBeNull();
      expect(remoteParentContext("00-zzzz-0123456789abcdef-01")).toBeNull();
    });

    it("should build a remote span context from valid traceparent", () => {
      const ctx = remoteParentContext(VALID_TP);
      expect(ctx).not.toBeNull();
      const span = trace.getSpan(ctx!);
      expect(span).toBeDefined();
      const sc = span!.spanContext();
      expect(sc.traceId).toBe("0123456789abcdef0123456789abcdef");
      expect(sc.spanId).toBe("0123456789abcdef");
      expect(sc.isRemote).toBe(true);
      expect(sc.traceFlags).toBe(1);
    });

    it("should parse sampled flags correctly", () => {
      const notSampled = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-00";
      const ctx = remoteParentContext(notSampled);
      expect(ctx).not.toBeNull();
      const sc = trace.getSpan(ctx!)!.spanContext();
      expect(sc.traceFlags).toBe(0);
      expect(sc.isRemote).toBe(true);
    });
  });

  describe("resolveRootContext", () => {
    it("should fall back to ROOT_CONTEXT when no valid parent", () => {
      expect(resolveRootContext(undefined)).toBe(ROOT_CONTEXT);
      expect(resolveRootContext("bad")).toBe(ROOT_CONTEXT);
    });

    it("should return remote context when valid", () => {
      const ctx = resolveRootContext(VALID_TP, "vendor=abc");
      expect(ctx).not.toBe(ROOT_CONTEXT);
      expect(trace.getSpan(ctx)).toBeDefined();
    });
  });
});
