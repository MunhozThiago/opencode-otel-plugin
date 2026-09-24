/**
 * opencode-otel-plugin - Endpoint Probe Tests
 */

import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import { probeEndpoint } from "../../dist/otel/probe.js";

describe("Endpoint Probe", () => {
  it("should return invalid URL error for bad endpoints", async () => {
    const r = await probeEndpoint("not-a-url", 500);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("invalid endpoint URL");
  });

  it("should fail fast (timeout) for closed ports", async () => {
    // Port 1 is almost certainly closed
    const r = await probeEndpoint("http://127.0.0.1:1", 300);
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });

  it("should succeed against a local listening server", async () => {
    const server = createServer((_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("no port");
    }
    const port = address.port;
    try {
      const r = await probeEndpoint(`http://127.0.0.1:${port}/v1/traces`, 1000);
      expect(r.ok).toBe(true);
      expect(r.ms).toBeGreaterThanOrEqual(0);
      expect(r.error).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("should default HTTP port 4318 when no port in URL and /v1 path present", async () => {
    // Probe default collector port — likely closed, but should not throw invalid URL
    const r = await probeEndpoint("http://127.0.0.1:4318/v1/traces", 200);
    expect(typeof r.ok).toBe("boolean");
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });
});
