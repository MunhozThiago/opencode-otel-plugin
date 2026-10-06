/**
 * opencode-otel-plugin - Smoke test
 *
 * End-to-end check without opencode:
 *   1. start a fake OTLP/HTTP collector on 127.0.0.1:4318
 *   2. load the built plugin (dist/) and run its factory
 *   3. dispatch synthetic events using the REAL opencode SDK shapes
 *   4. dispose (triggers forceFlush) and assert data actually left the process
 *
 * Fails (exit 1) if: any [otel] error/warning is logged, an event throws,
 * or no OTLP trace export arrives.
 *
 * Run: npm run smoke
 */

import http from "node:http";
import assert from "node:assert/strict";

const PORT = 4318;
const HOST = "127.0.0.1";
const SESSION_ID = "ses_smoke_0000000000000000000000000";

const received = { traces: 0, metrics: 0, logs: 0, bytes: 0, paths: [] };
const otelOutput = [];
const failures = [];

// ─── 1. Fake OTLP/HTTP collector ──────────────────────────────────────────────

const server = http.createServer((req, res) => {
  let bytes = 0;
  req.on("data", (chunk) => {
    bytes += chunk.length;
  });
  req.on("end", () => {
    const path = req.url || "";
    received.paths.push(`${req.method} ${path} (${bytes}b)`);
    received.bytes += bytes;
    if (path.includes("/v1/traces")) received.traces++;
    else if (path.includes("/v1/metrics")) received.metrics++;
    else if (path.includes("/v1/logs")) received.logs++;
    res.writeHead(200, { "content-type": "application/x-protobuf" });
    res.end(Buffer.alloc(0));
  });
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(PORT, HOST, resolve);
});
console.log(`[smoke] fake OTLP collector listening on http://${HOST}:${PORT}`);

// ─── 2. Capture plugin output ─────────────────────────────────────────────────

const original = { log: console.log, warn: console.warn, error: console.error };

function capture(label) {
  return (...args) => {
    const line = args
      .map((a) => (typeof a === "string" ? a : safeInspect(a)))
      .join(" ");
    if (line.includes("[otel]")) otelOutput.push(line);
    else original[label](...args);
  };
}
function safeInspect(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
console.log = capture("log");
console.warn = capture("warn");
console.error = capture("error");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(predicate, timeoutMs = 8000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(intervalMs);
  }
  return predicate();
}

// ─── 3. Load plugin and dispatch real-shaped events ───────────────────────────

let hooks;
try {
  const mod = await import(new URL("../dist/index.js", import.meta.url));
  const plugin = mod.default ?? mod.plugin;
  assert.equal(typeof plugin, "function", "dist/index.js must default-export the plugin factory");

  hooks = await plugin(
    { project: { id: "smoke-project" } },
    {
      endpoint: `http://${HOST}:${PORT}/v1/traces`,
      protocol: "http",
      debug: false,
      sampling: { rate: 1 },
      serviceName: "opencode-otel-plugin-smoke",
      environment: "smoke",
      resourceAttributes: { "project.id": "smoke-project" },
    }
  );
  assert.equal(typeof hooks.event, "function", "plugin must return an event hook");
  console.log("[smoke] plugin factory OK (hooks: " + Object.keys(hooks).join(", ") + ")");
} catch (err) {
  failures.push(`plugin factory threw: ${err?.stack || err}`);
}

const now = Date.now();
const events = [
  // session lifecycle (nested info shape)
  {
    type: "session.created",
    properties: {
      info: {
        id: SESSION_ID,
        projectID: "smoke-project",
        directory: "C:/smoke",
        agent: "primary",
        title: "smoke session",
        model: { providerID: "opencode", modelID: "smoke-model" },
        time: { created: now, updated: now },
      },
    },
  },
  // assistant message (nested info shape)
  {
    type: "message.updated",
    properties: {
      info: {
        id: "msg_smoke_1",
        sessionID: SESSION_ID,
        role: "assistant",
        agent: "primary",
        modelID: "smoke-model",
        providerID: "opencode",
        tokens: { input: 12, output: 6 },
        time: { created: now, completed: now },
      },
    },
  },
  // tool execution (hook-shaped payload)
  {
    type: "tool.execute.before",
    input: { tool: "read", sessionID: SESSION_ID, callID: "call_smoke_1" },
  },
  {
    type: "tool.execute.after",
    input: {
      tool: "read",
      sessionID: SESSION_ID,
      callID: "call_smoke_1",
      args: {},
      title: "Read",
      output: "hello",
      metadata: { durationMs: 12 },
    },
  },
  // REAL flat SDK shapes — the ones that used to blow up validation
  { type: "file.edited", properties: { file: "C:/smoke/example.ts" } },
  {
    type: "command.executed",
    properties: {
      name: "git commit -m smoke",
      sessionID: SESSION_ID,
      arguments: "",
      messageID: "msg_smoke_2",
    },
  },
  {
    type: "todo.updated",
    properties: {
      sessionID: SESSION_ID,
      todos: [{ id: "t1", content: "smoke todo", status: "pending", priority: "low" }],
    },
  },
  {
    type: "permission.updated",
    properties: {
      id: "perm_smoke_1",
      type: "edit",
      sessionID: SESSION_ID,
      messageID: "msg_smoke_3",
      title: "Edit file",
      pattern: "*.ts",
      metadata: {},
      time: { created: now },
    },
  },
  {
    type: "permission.replied",
    properties: { sessionID: SESSION_ID, permissionID: "perm_smoke_1", response: "allow" },
  },
  // ends the session + triggers a lifecycle forceFlush
  { type: "session.idle", properties: { sessionID: SESSION_ID } },
];

if (hooks?.event) {
  for (const event of events) {
    try {
      await hooks.event({ event });
    } catch (err) {
      failures.push(`event ${event.type} threw: ${err?.stack || err}`);
    }
  }
  console.log(`[smoke] dispatched ${events.length} events`);
}

// ─── 4. Dispose (forceFlush) and assert export ────────────────────────────────

try {
  if (typeof hooks?.dispose === "function") await hooks.dispose();
} catch (err) {
  failures.push(`dispose threw: ${err?.stack || err}`);
}

const exported = await waitFor(() => received.traces > 0, 10000);

console.log = original.log;
console.warn = original.warn;
console.error = original.error;

// ─── 5. Report ────────────────────────────────────────────────────────────────

console.log("[smoke] OTLP received:", {
  traces: received.traces,
  metrics: received.metrics,
  logs: received.logs,
  bytes: received.bytes,
});

const badOutput = otelOutput.filter((l) =>
  /failed|error|throw|invalid|must be/i.test(l)
);
if (otelOutput.length) {
  console.log(`[smoke] captured ${otelOutput.length} [otel] line(s):`);
  for (const l of otelOutput) console.log("   ", l);
}

if (badOutput.length) failures.push(`plugin logged errors: ${badOutput.join(" | ")}`);
if (!exported) {
  failures.push(
    `no OTLP trace export reached the collector within 10s (paths seen: ${
      received.paths.join(", ") || "none"
    })`
  );
}
if (received.traces > 0 && received.metrics === 0) {
  console.log("[smoke] note: no metric export (only fatal if you expect metrics)");
}
if (received.traces > 0 && received.logs === 0) {
  console.log("[smoke] note: no log export (only fatal if you expect logs)");
}

server.close();

if (failures.length) {
  console.error("\n[smoke] FAILED:");
  for (const f of failures) console.error("  -", f);
  process.exit(1);
}

console.log("\n[smoke] PASSED — plugin loaded, handled real-shaped events, exported traces");
process.exit(0);
