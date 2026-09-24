/**
 * opencode-otel-plugin - Endpoint Reachability Probe
 *
 * TCP connect probe with timeout + latency, called before SDK init.
 */

import { connect } from "node:net";
import { URL } from "node:url";

export interface ProbeResult {
  ok: boolean;
  ms: number;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 3000;

/**
 * Probe an OTLP endpoint for TCP reachability.
 * Never throws — returns { ok: false, error } on failure.
 */
export async function probeEndpoint(
  endpoint: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<ProbeResult> {
  const started = Date.now();
  let host: string;
  let port: number;
  try {
    const url = new URL(endpoint);
    host = url.hostname || "localhost";
    // gRPC default 4317, HTTP 4318; derive from URL if present
    if (url.port) {
      port = Number(url.port);
    } else if (url.protocol === "https:") {
      port = 443;
    } else {
      // Heuristic: if path looks like HTTP OTLP use 4318 else 4317
      port = endpoint.includes("/v1/") ? 4318 : 4317;
    }
  } catch {
    return { ok: false, ms: 0, error: "invalid endpoint URL" };
  }

  return new Promise((resolvePromise) => {
    let settled = false;
    const socket = connect({ host, port });
    const finish = (ok: boolean, error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolvePromise({
        ok,
        ms: Date.now() - started,
        ...(error ? { error } : {}),
      });
    };
    const timer = setTimeout(() => finish(false, `timeout after ${timeoutMs}ms`), timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", (err) => finish(false, err.message));
  });
}
