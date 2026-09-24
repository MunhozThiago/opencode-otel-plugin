/**
 * opencode-otel-plugin - Tool Hooks
 * 
 * Hooks for tool.execute.before, tool.execute.after, tool.definition
 */

import type { ToolDefinition } from "@opencode-ai/plugin";
import { trace } from "@opentelemetry/api";
import type { Span } from "@opentelemetry/api";
import type { RequiredConfig } from "../config.js";
import { generateConversationId } from "../utils/ids.js";
import { createBaseAttributes, addToolAttributes, flattenAttributes } from "../otel/semantic-conventions.js";
import { enrichSpanAttributes } from "../otel/provider.js";

// ─── Hook State ────────────────────────────────────────────────────────────────

interface ToolHookState {
  config: RequiredConfig;
  tracer: ReturnType<typeof trace.getTracer>;
  piiRedactor: any;
  activeSpans: Map<string, Span>;
  debug: boolean;
}

let toolHookState: ToolHookState | null = null;

export function initializeToolHooks(
  config: RequiredConfig,
  tracer: ReturnType<typeof trace.getTracer>,
  piiRedactor: any,
  activeSpans: Map<string, Span>
): void {
  toolHookState = {
    config,
    tracer,
    piiRedactor,
    activeSpans,
    debug: config.debug,
  };
}

// ─── tool.execute.before Hook ──────────────────────────────────────────────────

/**
 * Called before a tool is executed
 * Can modify tool arguments
 */
export async function handleToolExecuteBefore(
  input: {
    tool: string;
    sessionID: string;
    callID: string;
  },
  output: {
    args: any;
  }
): Promise<void> {
  if (!toolHookState) return;
  
  const { tracer, piiRedactor, activeSpans, debug } = toolHookState;
  const { tool, sessionID, callID } = input;
  
  const conversationId = generateConversationId(sessionID);
  // Agent info would come from conversation context
  
  if (debug) {
    console.log(`[otel] tool.execute.before: ${tool} (${callID})`);
  }
  
  // The actual span creation happens in the event hook
  // This hook can be used to modify args if needed
}

// ─── tool.execute.after Hook ───────────────────────────────────────────────────

/**
 * Called after a tool is executed
 * Receives tool output
 */
export async function handleToolExecuteAfter(
  input: {
    tool: string;
    sessionID: string;
    callID: string;
    args: any;
  },
  output: {
    title: string;
    output: string;
    metadata: any;
  }
): Promise<void> {
  if (!toolHookState) return;
  
  const { tracer, piiRedactor, activeSpans, debug } = toolHookState;
  const { tool, sessionID, callID, args } = input;
  const { title, output: toolOutput, metadata } = output;
  
  const conversationId = generateConversationId(sessionID);
  const span = activeSpans.get(`${conversationId}:tool:${callID}`);
  
  if (span) {
    // Update span with output
    const isMCP = tool.startsWith('mcp__') || tool.startsWith('mcp.');
    
    const toolAttrs = addToolAttributes(
      {} as any,
      {
        toolName: tool,
        toolCallId: callID,
        input: args,
        output: toolOutput,
        durationMs: metadata?.durationMs,
        isMCP,
        mcpServerName: metadata?.server,
        mcpSessionId: metadata?.sessionId,
      }
    );
    enrichSpanAttributes(span, toolAttrs, piiRedactor);
    
    if (title) {
      span.setAttribute('tool.title', title);
    }
    
    if (metadata?.error) {
      span.setAttribute('error', true);
      span.setAttribute('error.message', metadata.error);
    }
    
    span.end();
    activeSpans.delete(`${conversationId}:tool:${callID}`);
    
    if (debug) {
      console.log(`[otel] tool.execute.after: ${tool} (${callID}) - ${metadata?.error ? 'ERROR' : 'OK'}`);
    }
  }
}

// ─── tool.definition Hook ──────────────────────────────────────────────────────

/**
 * Modify tool definitions sent to LLM
 */
export async function handleToolDefinition(
  input: {
    toolID: string;
  },
  output: {
    description: string;
    parameters: any;
  }
): Promise<void> {
  if (!toolHookState) return;
  
  const { debug } = toolHookState;
  const { toolID } = input;
  
  if (debug) {
    console.log(`[otel] tool.definition: ${toolID}`);
  }
  
  // Could add metadata to tool definitions
}

// ─── Export ───────────────────────────────────────────────────────────────────

export const toolHooks = {
  executeBefore: handleToolExecuteBefore,
  executeAfter: handleToolExecuteAfter,
  definition: handleToolDefinition,
};

export function disposeToolHooks(): void {
  toolHookState = null;
}