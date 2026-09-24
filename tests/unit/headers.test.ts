/**
 * opencode-otel-plugin - Dynamic Headers Tests
 *
 * parseOtlpHeaders / isAuthFailure / DynamicHeaders (P0 auth-retry gap).
 */

import { describe, it, expect, vi } from "vitest";
import {
  parseOtlpHeaders,
  isAuthFailure,
  DynamicHeaders,
} from "../../dist/otel/headers.js";

describe("Dynamic Headers", () => {
  describe("parseOtlpHeaders", () => {
    it("should parse k=v,k2=v2 pairs", () => {
      expect(parseOtlpHeaders("a=1,b=2")).toEqual({ a: "1", b: "2" });
    });

    it("should handle values containing = signs", () => {
      expect(parseOtlpHeaders("token=abc=def")).toEqual({ token: "abc=def" });
    });

    it("should ignore malformed pairs and empty input", () => {
      expect(parseOtlpHeaders(undefined)).toEqual({});
      expect(parseOtlpHeaders("")).toEqual({});
      expect(parseOtlpHeaders("novalue,ok=1")).toEqual({ ok: "1" });
    });
  });

  describe("isAuthFailure", () => {
    it("should detect HTTP 401/403", () => {
      expect(isAuthFailure({ code: 401 })).toBe(true);
      expect(isAuthFailure({ statusCode: 403 })).toBe(true);
      expect(isAuthFailure({ status: 401 })).toBe(true);
    });

    it("should detect gRPC permission/unauthenticated codes", () => {
      expect(isAuthFailure({ code: 7 })).toBe(true); // PERMISSION_DENIED
      expect(isAuthFailure({ code: 16 })).toBe(true); // UNAUTHENTICATED
    });

    it("should detect message-based auth failures", () => {
      expect(isAuthFailure(new Error("401 Unauthorized"))).toBe(true);
      expect(isAuthFailure(new Error("permission_denied"))).toBe(true);
      expect(isAuthFailure(new Error("UNAUTHENTICATED"))).toBe(true);
    });

    it("should not flag non-auth errors", () => {
      expect(isAuthFailure(new Error("timeout"))).toBe(false);
      expect(isAuthFailure({ code: 500 })).toBe(false);
      expect(isAuthFailure(null)).toBe(false);
      expect(isAuthFailure(undefined)).toBe(false);
    });
  });

  describe("DynamicHeaders", () => {
    it("should start with static headers", () => {
      const h = new DynamicHeaders({ Authorization: "Bearer static" });
      expect(h.get()).toEqual({ Authorization: "Bearer static" });
      expect(h.hasHelper()).toBe(false);
      expect(h.getVersion()).toBe(0);
    });

    it("refresh without helper should keep static headers and bump version", async () => {
      const h = new DynamicHeaders({ Authorization: "Bearer a" });
      await h.refresh();
      expect(h.get()).toEqual({ Authorization: "Bearer a" });
      expect(h.getVersion()).toBe(1);
    });

    it("refresh with missing helper should keep previous headers", async () => {
      const h = new DynamicHeaders(
        { Authorization: "Bearer keep" },
        "/nonexistent/helper-binary-xyz"
      );
      expect(h.hasHelper()).toBe(true);
      await h.refresh(); // should not throw
      expect(h.get()).toEqual({ Authorization: "Bearer keep" });
    });

    it("concurrent refresh calls share one promise", async () => {
      const h = new DynamicHeaders({ a: "1" });
      const p1 = h.refresh();
      const p2 = h.refresh();
      await Promise.all([p1, p2]);
      expect(h.getVersion()).toBe(1);
    });
  });
});
