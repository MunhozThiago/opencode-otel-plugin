/**
 * opencode-otel-plugin - Main Entry Point
 * 
 * OpenTelemetry instrumentation plugin for opencode.
 * Exports multi-agent observability data via OTLP to a control plane.
 */

import type { Plugin, PluginInput, Hooks, Config } from "@opencode-ai/plugin";
import { trace } from "@opentelemetry/api";
import { mergeConfig, validateConfig, type RequiredConfig } from "./config.js";
import { createProvider, type ProviderSetupResult } from "./otel/provider.js";
import { createPIIRedactor } from "./utils/pii.js";
import { initializeEventHook, handleEvent, disposeEventHook } from "./hooks/event.js";
import { handleChatMessage, handleChatParams, handleChatHeaders, initializeChatHooks, disposeChatHooks } from "./hooks/chat.js";
import { handleToolExecuteBefore, handleToolExecuteAfter, handleToolDefinition, initializeToolHooks, disposeToolHooks } from "./hooks/tool.js";
import { handleSessionCompacting, handleCompactionAutocontinue, initializeSessionHooks, disposeSessionHooks } from "./hooks/session.js";
import type { OtelPluginOptions } from "./types.js";
import { probeEndpoint } from "./otel/probe.js";
import { resolveRootContext } from "./otel/trace-context.js";

// ─── Plugin State ──────────────────────────────────────────────────────────────

interface PluginState {
  providerSetup: ProviderSetupResult;
  config: RequiredConfig;
  activeSpans: Map<string, any>;
  isShuttingDown: boolean;
}

let pluginState: PluginState | null = null;
let signalHandlersInstalled = false;

// ─── Safe Hook Wrapper ─────────────────────────────────────────────────────────

function safeHook<Fn extends (...args: any[]) => any>(fn: Fn, name: string): Fn {
  return (async (...args: any[]) => {
    try {
      return await fn(...args);
    } catch (error) {
      console.error(`[otel] Hook ${name} failed:`, error);
      // Never throw — observability must not break host
      return undefined;
    }
  }) as any;
}

// ─── Signal Handlers (SIGTERM/SIGINT/beforeExit) ───────────────────────────────

function installSignalHandlers(): void {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;

  const onSignal = (signal: string) => {
    if (!pluginState || pluginState.isShuttingDown) return;
    console.log(`[otel] Received ${signal}, shutting down...`);
    void shutdown().finally(() => {
      // Allow default behavior after flush
      if (signal === 'SIGINT' || signal === 'SIGTERM') {
        process.exit(0);
      }
    });
  };

  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('beforeExit', () => {
    if (pluginState && !pluginState.isShuttingDown) {
      void shutdown();
    }
  });
}

// ─── Main Plugin Factory ───────────────────────────────────────────────────────

const plugin: Plugin = async (
  input: PluginInput,
  options?: OtelPluginOptions
): Promise<Hooks> => {
  // 1. Merge and validate configuration
  const config = mergeConfig(options);
  validateConfig(config);

  if (config.debug) {
    console.log('[otel] Plugin starting with config:', {
      endpoint: config.endpoint,
      protocol: config.protocol,
      serviceName: config.serviceName,
      environment: config.environment,
      samplingRate: config.sampling.rate,
      metricPrefix: config.metricPrefix,
      disabledTraces: config.disabledTraces,
      disabledLogs: config.disabledLogs,
    });
  }

  // 1b. Endpoint probe (warn-but-continue)
  if (config.protocol === 'http' && !config.disabledTraces) {
    try {
      const probe = await probeEndpoint(config.endpoint, 2000);
      if (!probe.ok && config.debug) {
        console.warn(`[otel] Endpoint probe failed for ${config.endpoint}: ${probe.error} (continuing)`);
      } else if (config.debug) {
        console.log(`[otel] Endpoint probe OK in ${probe.ms}ms`);
      }
    } catch (e) {
      if (config.debug) console.warn('[otel] Endpoint probe error (continuing):', e);
    }
  }

  // 1c. Remote parent context (OPENCODE_TRACEPARENT / options)
  const remoteCtx = resolveRootContext(config.traceparent, config.tracestate);
  if (config.traceparent && config.debug) {
    console.log('[otel] Using remote parent trace context');
  }
  void remoteCtx; // applied implicitly via global propagator on extract; root spans use active context

  // 2. Initialize OpenTelemetry provider
  const providerSetup = await createProvider(config);

  // 3. Create PII redactor
  const piiRedactor = createPIIRedactor(config.piiRedaction as any);

  // 4. Get tracer
  const tracer = trace.getTracer('opencode-otel-plugin', config.serviceVersion);

  // 5. Initialize shared state
  const activeSpans = new Map<string, any>();

  pluginState = {
    providerSetup,
    config,
    activeSpans,
    isShuttingDown: false,
  };

  // 6. Initialize all hooks (pass metrics/logs + forceFlush for lifecycle)
  initializeEventHook(input, config, tracer, piiRedactor, {
    metrics: providerSetup.metrics,
    logs: providerSetup.logs,
    forceFlush: providerSetup.forceFlush,
  });
  initializeChatHooks(config, activeSpans);
  initializeToolHooks(config, tracer, piiRedactor, activeSpans);
  initializeSessionHooks(config, tracer, piiRedactor, activeSpans);

  // 6b. Install process signal handlers
  installSignalHandlers();

  // 7. Return hooks (all wrapped in safe() to isolate host from telemetry failures)
  const hooks: Hooks = {
    event: safeHook(handleEvent as any, 'event'),
    "chat.message": safeHook(handleChatMessage as any, 'chat.message'),
    "chat.params": safeHook(handleChatParams as any, 'chat.params'),
    "chat.headers": safeHook(handleChatHeaders as any, 'chat.headers'),
    "tool.execute.before": safeHook(handleToolExecuteBefore as any, 'tool.execute.before'),
    "tool.execute.after": safeHook(handleToolExecuteAfter as any, 'tool.execute.after'),
    "tool.definition": safeHook(handleToolDefinition as any, 'tool.definition'),
    "experimental.session.compacting": safeHook(handleSessionCompacting as any, 'experimental.session.compacting'),
    "experimental.compaction.autocontinue": safeHook(handleCompactionAutocontinue as any, 'experimental.compaction.autocontinue'),
    config: async (cfg: Config) => {
      if (config.debug) {
        console.log('[otel] Config validated');
      }
    },
    dispose: async () => {
      await shutdown();
    },
  };

  if (config.debug) {
    console.log('[otel] Plugin initialized successfully');
  }

  return hooks;
};

// ─── Shutdown ──────────────────────────────────────────────────────────────────

async function shutdown(): Promise<void> {
  if (!pluginState || pluginState.isShuttingDown) return;

  pluginState.isShuttingDown = true;
  const { providerSetup, config, activeSpans } = pluginState;

  if (config.debug) {
    console.log('[otel] Shutting down...');
  }

  try {
    // End all active spans
    for (const [key, span] of activeSpans.entries()) {
      try {
        span.end();
      } catch (e) {
        // Ignore errors during shutdown
      }
    }
    activeSpans.clear();

    // Dispose hooks
    disposeEventHook();
    disposeChatHooks();
    disposeToolHooks();
    disposeSessionHooks();

    // Final forceFlush + shutdown provider
    if (providerSetup.forceFlush) {
      try { await providerSetup.forceFlush(); } catch { /* ignore */ }
    }
    await providerSetup.shutdown();

    if (config.debug) {
      console.log('[otel] Shutdown complete');
    }
  } catch (error) {
    console.error('[otel] Error during shutdown:', error);
  } finally {
    pluginState = null;
  }
}

// ─── Utility Exports ───────────────────────────────────────────────────────────

export function getTracer(): ReturnType<typeof trace.getTracer> | null {
  return pluginState ? trace.getTracer('opencode-otel-plugin', pluginState.config.serviceVersion) : null;
}

export function getActiveSpans(): Map<string, any> | null {
  return pluginState?.activeSpans || null;
}

export function isPluginActive(): boolean {
  return pluginState !== null && !pluginState.isShuttingDown;
}

/** Manually force-flush traces/metrics/logs (also called on idle/error/signals). */
export async function forceFlush(): Promise<void> {
  if (pluginState?.providerSetup?.forceFlush) {
    await pluginState.providerSetup.forceFlush();
  }
}

// ─── Export ───────────────────────────────────────────────────────────────────

export default plugin;
/** Named export for hosts that resolve named plugin exports (e.g. opencode). */
export { plugin as otelPlugin };
export { plugin as OtelPlugin };
export type { OtelPluginOptions } from "./types.js";