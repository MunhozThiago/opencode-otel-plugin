/**
 * opencode-otel-plugin - Chat Hooks
 * 
 * Hooks for chat.message, chat.params, chat.headers
 */

import type { PluginInput } from "@opencode-ai/plugin";
import type { UserMessage, Part, Model } from "@opencode-ai/sdk";
import { trace, propagation, context } from "@opentelemetry/api";
import type { Span, SpanKind } from "@opentelemetry/api";
import type { RequiredConfig } from "../config.js";
import { generateConversationId, generateAgentId, getConversationContext } from "../utils/ids.js";
import { createBaseAttributes, addChatAttributes, flattenAttributes } from "../otel/semantic-conventions.js";
import { enrichSpanAttributes } from "../otel/provider.js";

// ProviderContext type from opencode SDK (using any to match expected type)
type ProviderContext = any;

// ─── Hook State ────────────────────────────────────────────────────────────────

interface ChatHookState {
  config: RequiredConfig;
  activeSpans: Map<string, Span>;
  debug: boolean;
}

let chatHookState: ChatHookState | null = null;

export function initializeChatHooks(config: RequiredConfig, activeSpans: Map<string, Span>): void {
  chatHookState = {
    config,
    activeSpans,
    debug: config.debug,
  };
}

// ─── chat.message Hook ─────────────────────────────────────────────────────────

/**
 * Called when a new message is received
 * Can be used to modify the message before it's sent to the LLM
 */
export async function handleChatMessage(
  input: {
    sessionID: string;
    agent?: string;
    model?: { providerID: string; modelID: string };
    messageID?: string;
    variant?: string;
  },
  output: {
    message: UserMessage;
    parts: Part[];
  }
): Promise<void> {
  if (!chatHookState) return;
  
  const { config, activeSpans, debug } = chatHookState;
  const { sessionID, agent, model } = input;
  
  if (!model) return;

  const conversationId = generateConversationId(sessionID);
  const agentName = agent || 'primary';
  const agentId = generateAgentId(agentName, sessionID);

  // This hook fires before the LLM call
  // We could create a "pending" span here, but the actual span
  // is created when the response comes back (message.updated)
  
  if (debug) {
    console.log(`[otel] chat.message: ${sessionID} agent=${agentName} model=${model.modelID}`);
  }
}

// ─── chat.params Hook ──────────────────────────────────────────────────────────

/**
 * Modify parameters sent to LLM
 */
export async function handleChatParams(
  input: {
    sessionID: string;
    agent: string;
    model: Model;
    provider: { id: string; name: string; source: string; env: string[]; key?: string; options: Record<string, unknown>; models: Record<string, Model> };
    message: UserMessage;
  },
  output: {
    temperature: number;
    topP: number;
    topK: number;
    maxOutputTokens: number | undefined;
    options: Record<string, any>;
  }
): Promise<void> {
  if (!chatHookState) return;
  
  const { config, debug } = chatHookState;
  const { sessionID, agent, model, provider } = input;
  
  if (debug) {
    console.log(`[otel] chat.params: ${sessionID} agent=${agent} model=${model.id}`);
  }
  
  // Could capture model parameters as span attributes
  // when the actual LLM span is created
}

// ─── chat.headers Hook ─────────────────────────────────────────────────────────

/**
 * Modify headers sent to LLM provider
 * Injects W3C TraceContext + Baggage using the keyed LLM request span when available
 * (falls back to ambient context). Provider allowlist controls which providers get headers.
 */
export async function handleChatHeaders(
  input: {
    sessionID: string;
    agent: string;
    model: Model;
    provider: { id: string; name: string; source: string; env: string[]; key?: string; options: Record<string, unknown>; models: Record<string, Model> };
    message: UserMessage;
  },
  output: {
    headers: Record<string, string>;
  }
): Promise<void> {
  if (!chatHookState) return;

  const { config, debug } = chatHookState;
  const { sessionID, agent, provider } = input;

  // Provider allowlist (default: common LLM providers)
  const providerId = provider?.id;
  const { isProviderAllowed, getLlmRequestContext, buildTraceParent } = await import("../otel/llm-contexts.js");
  if (!isProviderAllowed(providerId)) {
    if (debug) {
      console.log(`[otel] chat.headers: provider ${providerId} not in allowlist, skipping injection`);
    }
    return;
  }

  const conversationId = generateConversationId(sessionID);
  const agentId = generateAgentId(agent, sessionID);

  const traceHeaders: Record<string, string> = {};

  // Prefer keyed LLM request context (real span from message.updated)
  const llmCtx = getLlmRequestContext(sessionID);
  if (llmCtx?.span) {
    traceHeaders['traceparent'] = buildTraceParent(llmCtx.span);
  } else {
    // Fallback: ambient active span
    const currentContext = context.active();
    const span = trace.getSpan(currentContext);
    if (span) {
      const spanContext = span.spanContext();
      const traceFlags = spanContext.traceFlags.toString(16).padStart(2, '0');
      traceHeaders['traceparent'] = `00-${spanContext.traceId}-${spanContext.spanId}-${traceFlags}`;
    }
  }

  // GenAI baggage entries
  const baggageEntries: string[] = [
    `gen_ai.conversation.id=${conversationId}`,
    `gen_ai.agent.id=${agentId}`,
    `gen_ai.session.id=${sessionID}`,
  ];

  // Merge existing baggage from context if present
  // @ts-expect-error - context.getValue type inference issue
  const existingBaggage = context.getValue('baggage') as Map<string, string> | undefined;
  if (existingBaggage) {
    existingBaggage.forEach((value: string, key: string) => {
      baggageEntries.push(`${key}=${encodeURIComponent(value)}`);
    });
  }

  if (baggageEntries.length > 0) {
    traceHeaders['baggage'] = baggageEntries.join(',');
  }

  output.headers = {
    ...output.headers,
    ...traceHeaders,
  };

  if (debug) {
    console.log(`[otel] chat.headers: ${sessionID} agent=${agent} provider=${providerId}`, {
      traceparent: traceHeaders['traceparent'],
      baggage: traceHeaders['baggage'],
      source: llmCtx ? 'keyed' : 'ambient',
    });
  }
}

// ─── Export ───────────────────────────────────────────────────────────────────

export const chatHooks = {
  message: handleChatMessage,
  params: handleChatParams,
  headers: handleChatHeaders,
};

export function disposeChatHooks(): void {
  chatHookState = null;
}