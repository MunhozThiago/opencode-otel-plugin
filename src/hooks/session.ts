/**
 * opencode-otel-plugin - Session Hooks
 * 
 * Hooks for experimental.session.compacting, experimental.compaction.autocontinue
 */

import type { UserMessage, Model } from "@opencode-ai/sdk";
import { trace } from "@opentelemetry/api";
import type { Span } from "@opentelemetry/api";
import type { RequiredConfig } from "../config.js";
import { generateConversationId } from "../utils/ids.js";
import { createBaseAttributes, flattenAttributes } from "../otel/semantic-conventions.js";
import { enrichSpanAttributes } from "../otel/provider.js";

// ProviderContext type from opencode SDK (using any to match expected type)
type ProviderContext = any;

// ─── Hook State ────────────────────────────────────────────────────────────────

interface SessionHookState {
  config: RequiredConfig;
  tracer: ReturnType<typeof trace.getTracer>;
  piiRedactor: any;
  activeSpans: Map<string, Span>;
  debug: boolean;
}

let sessionHookState: SessionHookState | null = null;

export function initializeSessionHooks(
  config: RequiredConfig,
  tracer: ReturnType<typeof trace.getTracer>,
  piiRedactor: any,
  activeSpans: Map<string, Span>
): void {
  sessionHookState = {
    config,
    tracer,
    piiRedactor,
    activeSpans,
    debug: config.debug,
  };
}

// ─── experimental.session.compacting Hook ──────────────────────────────────────

/**
 * Called before session compaction starts
 * Allows plugins to customize the compaction prompt
 */
export async function handleSessionCompacting(
  input: {
    sessionID: string;
  },
  output: {
    context: string[];
    prompt?: string;
  }
): Promise<void> {
  if (!sessionHookState) return;
  
  const { tracer, piiRedactor, activeSpans, debug } = sessionHookState;
  const { sessionID } = input;
  
  const conversationId = generateConversationId(sessionID);
  
  // Create compaction span
  const span = tracer.startSpan(`session.compaction`, {
    kind: 0, // INTERNAL
    attributes: flattenAttributes(createBaseAttributes(sessionID, '', '', conversationId, 'compaction')),
  });
  
  span.setAttribute('session.compaction.custom_prompt', !!output.prompt);
  span.setAttribute('session.compaction.context_items', output.context.length);
  
  enrichSpanAttributes(span, {} as any, piiRedactor);
  span.end();
  
  if (debug) {
    console.log(`[otel] session.compacting: ${sessionID}`);
  }
}

// ─── experimental.compaction.autocontinue Hook ─────────────────────────────────

/**
 * Called after compaction succeeds and before synthetic continue message
 */
export async function handleCompactionAutocontinue(
  input: {
    sessionID: string;
    agent: string;
    model: Model;
    provider: ProviderContext;
    message: UserMessage;
    overflow: boolean;
  },
  output: {
    enabled: boolean;
  }
): Promise<void> {
  if (!sessionHookState) return;
  
  const { debug } = sessionHookState;
  const { sessionID, agent, overflow } = input;
  
  if (debug) {
    console.log(`[otel] compaction.autocontinue: ${sessionID} agent=${agent} overflow=${overflow} enabled=${output.enabled}`);
  }
  
  // Could track this as a span event
}

// ─── Export ───────────────────────────────────────────────────────────────────

export const sessionHooks = {
  compacting: handleSessionCompacting,
  autocontinue: handleCompactionAutocontinue,
};

export function disposeSessionHooks(): void {
  sessionHookState = null;
}