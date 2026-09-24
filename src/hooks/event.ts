/**
 * opencode-otel-plugin - Main Event Hook
 * 
 * Central event handler that routes opencode events to appropriate mappers.
 */

import type { PluginInput } from "@opencode-ai/plugin";
import type { Event as SDKEvent } from "@opencode-ai/sdk";
import type { Span } from "@opentelemetry/api";
import { trace } from "@opentelemetry/api";
import type { RequiredConfig } from "../config.js";
import type { ConversationContext, AgentInfo } from "../types.js";

// Extended event type to include hook events
type Event = SDKEvent & {
  type: string;
  properties?: any;
  input?: any;
};
import { sessionMapper } from "../mappers/session.js";
import { messageMapper } from "../mappers/message.js";
import { toolMapper } from "../mappers/tool.js";
import { delegationMapper } from "../mappers/delegation.js";
import { mapTodoUpdated } from "../mappers/todo.js";
import { mapCommandExecuted } from "../mappers/command.js";
import { mapFileEdited } from "../mappers/file.js";
import { mapMCPToolCall, mapMCPToolResult, mapMCPToolError } from "../mappers/mcp.js";
import { mapMemoryOperation } from "../mappers/memory.js";
import { mapPlanEvent, mapWorkflowEvent } from "../mappers/plan.js";
import { generateConversationId, getConversationContext, getOrCreateConversationContext, generateAgentId, extractAgentInfo } from "../utils/ids.js";
import type { GenAIMetrics } from "../otel/metrics.js";
import type { AgentLogger } from "../otel/logs.js";
import { setBoundedMap, sweepMap, MAX_PENDING } from "../utils/bounded.js";
import { setLlmRequestContext } from "../otel/llm-contexts.js";

// ─── Hook State ────────────────────────────────────────────────────────────────

export interface EventTelemetry {
  metrics?: GenAIMetrics | null;
  logs?: AgentLogger | null;
  forceFlush?: (() => Promise<void>) | null;
}

interface EventHookState {
  config: RequiredConfig;
  tracer: ReturnType<typeof trace.getTracer>;
  piiRedactor: any;
  activeSpans: Map<string, Span>;
  agentRegistry: Map<string, AgentInfo>;
  conversationContexts: Map<string, ConversationContext>;
  debug: boolean;
  metrics?: GenAIMetrics | null;
  logs?: AgentLogger | null;
  forceFlush?: (() => Promise<void>) | null;
  sessionStartTimes: Map<string, number>;
  sessionTokenTotals: Map<string, number>;
  projectId?: string;
}

let hookState: EventHookState | null = null;

// ─── Lifecycle ForceFlush ──────────────────────────────────────────────────────

async function lifecycleForceFlush(): Promise<void> {
  if (!hookState?.forceFlush) return;
  try {
    await hookState.forceFlush();
  } catch (e) {
    if (hookState.debug) console.warn('[otel] lifecycle forceFlush failed:', e);
  }
}

// ─── Initialize Hook State ────────────────────────────────────────────────────

export function initializeEventHook(
  input: PluginInput,
  config: RequiredConfig,
  tracer: ReturnType<typeof trace.getTracer>,
  piiRedactor: any,
  telemetry?: EventTelemetry
): void {
  hookState = {
    config,
    tracer,
    piiRedactor,
    activeSpans: new Map(),
    agentRegistry: new Map(),
    conversationContexts: new Map(),
    debug: config.debug,
    metrics: telemetry?.metrics ?? null,
    logs: telemetry?.logs ?? null,
    forceFlush: telemetry?.forceFlush ?? null,
    sessionStartTimes: new Map(),
    sessionTokenTotals: new Map(),
    projectId:
      config.resourceAttributes?.["project.id"] ??
      (input?.project as any)?.id ??
      (input as any)?.project?.id,
  };

  if (config.debug) {
    console.log('[otel] Event hook initialized');
  }
}

// ─── Main Event Handler ────────────────────────────────────────────────────────

export async function handleEvent(input: { event: any }): Promise<void> {
  if (!hookState) return;
  
  const { event } = input;
  const { config, tracer, piiRedactor, activeSpans, agentRegistry, conversationContexts, debug } = hookState;

  try {
    // Record operation duration for all events (best-effort)
    const startedAt = Date.now();

    // Attach project.id common attribute when known (P2)
    if (hookState.projectId) {
      // Best-effort: mark on conversation root spans when present
      const propsSession =
        (event as any)?.properties?.info?.sessionID ||
        (event as any)?.properties?.sessionID ||
        (event as any)?.input?.sessionID;
      if (propsSession) {
        const convId = generateConversationId(propsSession);
        const root = activeSpans.get(`${convId}:root`);
        if (root) {
          try {
            root.setAttribute('project.id', hookState.projectId);
            root.setAttribute('session.project_id', hookState.projectId);
          } catch { /* ignore */ }
        }
      }
    }

    // Route to appropriate mapper based on event type
    switch (event.type) {
      // Session lifecycle
      case 'session.created':
        await handleSessionCreated(event, tracer, piiRedactor, activeSpans, agentRegistry, conversationContexts);
        break;
      case 'session.updated':
        sessionMapper.updated(event, activeSpans);
        break;
      case 'session.deleted':
        sessionMapper.deleted(event, activeSpans);
        break;
      case 'session.status':
        sessionMapper.status(event, activeSpans);
        break;
      case 'session.idle':
        // Session went idle — flush pending telemetry and emit session totals
        await handleSessionIdle(event);
        break;
      case 'session.compacted':
        await handleSessionCompacted(event, tracer, piiRedactor, activeSpans);
        break;
      case 'session.error':
        sessionMapper.error(event, activeSpans);
        await handleSessionIdle(event, 'error');
        break;

      // Message events
      case 'message.updated':
        await handleMessageUpdated(event, tracer, piiRedactor, activeSpans, agentRegistry, conversationContexts);
        // Flush after assistant (message complete) to reduce data-loss risk
        if ((event as any).properties?.info?.role === 'assistant') {
          await lifecycleForceFlush();
        }
        break;
      case 'message.removed':
        // Message removed - cleanup if needed
        break;
      case 'message.part.updated':
        await handleMessagePartUpdated(event, tracer, piiRedactor, activeSpans, agentRegistry, conversationContexts);
        break;
      case 'message.part.removed':
        // Part removed - cleanup if needed
        break;

      // Tool events (from hooks)
      case 'tool.execute.before':
        toolMapper.executeBefore(event, tracer, piiRedactor, activeSpans);
        break;
      case 'tool.execute.after':
        toolMapper.executeAfter(event, tracer, piiRedactor, activeSpans);
        if (hookState?.metrics) {
          const props = (event as any).properties || (event as any).input || {};
          const meta = props.metadata || props.output?.metadata || {};
          const durationMs = meta.durationMs;
          const toolName = props.tool || props.toolName || 'unknown';
          if (typeof durationMs === 'number' && durationMs >= 0) {
            hookState.metrics.recordToolDuration(durationMs, {
              tool: toolName,
              'gen_ai.session.id': props.sessionID,
              'tool.error': meta.error ? 1 : 0,
            });
          }
          if (meta.error) {
            hookState.logs?.toolResult(String(meta.error), {
              tool: toolName,
              sessionId: props.sessionID,
              success: false,
            });
          } else {
            hookState.logs?.toolResult('tool completed', {
              tool: toolName,
              sessionId: props.sessionID,
              success: true,
            });
          }
        }
        break;

      // Permission events
      case 'permission.ask':
        toolMapper.permissionAsk(event, tracer, piiRedactor, activeSpans);
        hookState?.logs?.toolDecision('permission pending', {
          operation: 'permission',
          sessionId: (event as any).properties?.sessionID ?? (event as any).properties?.info?.sessionID,
        });
        break;
      case 'permission.replied':
        toolMapper.permissionReplied(event, tracer, piiRedactor, activeSpans);
        hookState?.logs?.toolDecision('permission replied', {
          operation: 'permission',
          sessionId: (event as any).properties?.sessionID ?? (event as any).properties?.info?.sessionID,
          decision: String((event as any).properties?.reply?.decision ?? (event as any).properties?.reply ?? ''),
        });
        break;

      // Todo events
      case 'todo.updated':
        mapTodoUpdated(event as any, tracer, activeSpans);
        break;

      // Command events
      case 'command.executed':
        mapCommandExecuted(event as any, tracer, piiRedactor, activeSpans);
        if (hookState?.metrics) {
          const info = (event as any).properties?.info;
          if (info && info.exitCode === 0 && typeof info.command === 'string') {
            if (/\bgit\s+commit\b/.test(info.command)) {
              hookState.metrics.recordCommit({ 'command.name': info.command });
              hookState.logs?.commit('git commit', { sessionId: info.sessionID });
            }
          }
        }
        break;

      // File events
      case 'file.edited':
        mapFileEdited(event as any, tracer, piiRedactor, activeSpans);
        if (hookState?.metrics) {
          const f = (event as any).properties?.info;
          if (f && (f.linesAdded || f.linesRemoved)) {
            hookState.metrics.recordLinesOfCode(f.linesAdded || 0, f.linesRemoved || 0, {
              'file.operation': f.operation,
              'gen_ai.session.id': f.sessionID,
            });
          }
        }
        break;

      // MCP tool events
      case 'mcp.tool.call':
        mapMCPToolCall(event as any, tracer, piiRedactor, activeSpans);
        break;
      case 'mcp.tool.result':
        mapMCPToolResult(event as any, activeSpans);
        if (hookState?.metrics) {
          const r = (event as any).properties?.info || (event as any).properties || {};
          if (typeof r.durationMs === 'number' && r.durationMs >= 0) {
            hookState.metrics.recordToolDuration(r.durationMs, {
              tool: r.tool || r.name || 'mcp',
              tool_system: 'mcp',
            });
          }
          if (r.cached === true || r.cacheHit === true) {
            hookState.metrics.recordCache(true, { tool: r.tool || r.name });
          } else if (r.cached === false || r.cacheHit === false) {
            hookState.metrics.recordCache(false, { tool: r.tool || r.name });
          }
        }
        break;
      case 'mcp.tool.error':
        mapMCPToolError(event as any, activeSpans);
        if (hookState?.metrics) {
          const err = (event as any).properties?.info || {};
          hookState.metrics.recordError({ 'error.type': 'mcp_tool', tool: err.tool || err.name });
          hookState.metrics.recordRetry({ reason: 'mcp_tool_error' });
        }
        break;

      // Memory events
      case 'memory.create':
      case 'memory.search':
      case 'memory.update':
      case 'memory.delete':
        mapMemoryOperation(event as any, tracer, piiRedactor, activeSpans);
        break;

      // Plan events
      case 'plan.created':
      case 'plan.updated':
      case 'plan.step':
      case 'plan.completed':
      case 'plan.failed':
        mapPlanEvent(event as any, tracer, piiRedactor, activeSpans);
        break;

      // Workflow events
      case 'workflow.started':
      case 'workflow.step':
      case 'workflow.completed':
      case 'workflow.failed':
        mapWorkflowEvent(event as any, tracer, piiRedactor, activeSpans);
        break;

      default:
        if (debug) {
          console.log(`[otel] Unhandled event type: ${event.type}`);
        }
    }

    // Record metrics for handled events (session/message ops)
    if (hookState?.metrics && isMetricEvent(event.type)) {
      hookState.metrics.recordInvocation({
        'gen_ai.operation.name': mapEventToOperation(event.type),
        'event.type': event.type,
      });
      hookState.metrics.recordDuration(Date.now() - startedAt, {
        'gen_ai.operation.name': mapEventToOperation(event.type),
        'event.type': event.type,
      });
    }

    if (hookState?.logs && isLoggableEvent(event.type)) {
      hookState.logs.debug(`handled ${event.type}`, {
        operation: mapEventToOperation(event.type),
        durationMs: Date.now() - startedAt,
      });
    }
  } catch (error) {
    if (hookState?.metrics) {
      hookState.metrics.recordError({
        'event.type': event.type,
        'error.type': error instanceof Error ? error.name : 'unknown',
      });
    }
    if (hookState?.logs) {
      hookState.logs.error(`error handling ${event.type}`, {
        error: error instanceof Error ? error.message : String(error),
        operation: mapEventToOperation(event.type),
      });
    }
    if (debug) {
      console.error(`[otel] Error handling event ${event.type}:`, error);
    }
    // Never throw - observability shouldn't break core functionality
  }
}

// ─── Metrics/Logs Helpers ─────────────────────────────────────────────────────

const METRIC_EVENTS = new Set([
  'session.created',
  'session.deleted',
  'session.error',
  'message.updated',
  'message.part.updated',
  'tool.execute.before',
  'tool.execute.after',
  'permission.ask',
  'command.executed',
  'file.edited',
  'mcp.tool.call',
  'mcp.tool.result',
  'mcp.tool.error',
  'memory.create',
  'memory.search',
  'memory.update',
  'memory.delete',
  'plan.created',
  'plan.completed',
  'plan.failed',
  'workflow.started',
  'workflow.completed',
  'workflow.failed',
]);

const LOGGABLE_EVENTS = new Set([
  'session.created',
  'session.deleted',
  'session.error',
  'session.compacted',
  'message.updated',
]);

function isMetricEvent(type: string): boolean {
  return METRIC_EVENTS.has(type);
}

function isLoggableEvent(type: string): boolean {
  return LOGGABLE_EVENTS.has(type);
}

function mapEventToOperation(type: string): string {
  if (type.startsWith('session.')) return 'session';
  if (type.startsWith('message.')) return 'chat';
  if (type.startsWith('tool.')) return 'execute_tool';
  if (type.startsWith('mcp.')) return 'execute_tool';
  if (type.startsWith('command.')) return 'execute_command';
  if (type.startsWith('file.')) return 'file_operation';
  if (type.startsWith('memory.')) return 'memory_operation';
  if (type.startsWith('plan.')) return 'plan';
  if (type.startsWith('workflow.')) return 'workflow';
  if (type.startsWith('permission.')) return 'permission';
  return 'other';
}

// ─── Session Handlers ─────────────────────────────────────────────────────────

async function handleSessionIdle(event: Event, reason: 'idle' | 'error' = 'idle'): Promise<void> {
  const sessionID = (event as any).properties?.sessionID ?? (event as any).properties?.info?.id;
  const conversationId = sessionID ? generateConversationId(sessionID) : undefined;

  // Session duration + token totals
  if (hookState?.metrics && sessionID) {
    const started = hookState.sessionStartTimes.get(sessionID);
    if (started !== undefined) {
      const durationMs = Date.now() - started;
      hookState.metrics.recordSessionDuration(durationMs, {
        'gen_ai.session.id': sessionID,
        reason,
      });
      hookState.sessionStartTimes.delete(sessionID);
    }
    const tokens = hookState.sessionTokenTotals.get(sessionID) ?? 0;
    if (tokens > 0) {
      hookState.metrics.recordSessionTokenTotal(tokens, { 'gen_ai.session.id': sessionID });
      hookState.sessionTokenTotals.delete(sessionID);
    }
  }

  // Log session idle/error
  if (reason === 'error') {
    hookState?.logs?.sessionError('session error', { sessionId: sessionID });
  } else {
    hookState?.logs?.sessionIdle('session idle', { sessionId: sessionID });
  }

  // Sweep orphan spans for this conversation (bounded cleanup)
  if (conversationId && hookState) {
    const toEnd: Array<[string, Span]> = [];
    for (const [key, span] of hookState.activeSpans.entries()) {
      if (key.startsWith(conversationId)) {
        toEnd.push([key, span]);
      }
    }
    for (const [key, span] of toEnd) {
      try {
        span.end();
      } catch { /* ignore */ }
      hookState.activeSpans.delete(key);
    }
  }

  // Lifecycle flush on idle/error
  await lifecycleForceFlush();
}

async function handleSessionCreated(
  event: Event,
  tracer: ReturnType<typeof trace.getTracer>,
  piiRedactor: any,
  activeSpans: Map<string, Span>,
  agentRegistry: Map<string, AgentInfo>,
  conversationContexts: Map<string, ConversationContext>
): Promise<void> {
  const session = (event as any).properties?.info;
  if (!session) return;

  const sessionId = session.id;
  const conversationId = generateConversationId(sessionId);
  const agentName = session.agent || "primary";
  const agentId = generateAgentId(agentName, sessionId);

  // Create conversation context (bounded)
  const convCtx = getOrCreateConversationContext(conversationId, sessionId, agentId, agentName);
  setBoundedMap(conversationContexts, conversationId, convCtx, MAX_PENDING);

  // Create root agent info (bounded)
  const agentInfo = extractAgentInfo(agentName, sessionId, session.model, undefined, undefined, []);
  setBoundedMap(agentRegistry, agentId, agentInfo, MAX_PENDING);
  convCtx.agents.set(agentId, agentInfo);

  // Create root span (bounded)
  const span = sessionMapper.created(event as any, tracer, piiRedactor, hookState!.config);
  if (span) {
    agentInfo.span = span;
    setBoundedMap(activeSpans, `${conversationId}:root`, span, MAX_PENDING);
    setBoundedMap(activeSpans, `${conversationId}:agent:${agentId}`, span, MAX_PENDING);
  }

  hookState?.sessionStartTimes?.set(sessionId, Date.now());
  hookState?.metrics?.recordSessionCount({
    'gen_ai.agent.name': agentName,
    'gen_ai.session.id': sessionId,
  });
  hookState?.metrics?.recordInvocation({
    'gen_ai.operation.name': 'invoke_agent',
    'gen_ai.agent.name': agentName,
    'gen_ai.session.id': sessionId,
  });
  hookState?.logs?.sessionCreated('session created', {
    sessionId,
    conversationId,
    agentName,
    operation: 'invoke_agent',
  });

  if (hookState?.debug) {
    console.log(`[otel] Session created: ${sessionId}, conversation: ${conversationId}, agent: ${agentName}`);
  }
}

async function handleSessionCompacted(
  event: Event,
  tracer: ReturnType<typeof trace.getTracer>,
  piiRedactor: any,
  activeSpans: Map<string, Span>
): Promise<void> {
  const span = sessionMapper.compacted(event as any, tracer, piiRedactor, activeSpans);
  if (span && hookState?.debug) {
    console.log('[otel] Session compacted');
  }
}

// ─── Message Handlers ─────────────────────────────────────────────────────────

async function handleMessageUpdated(
  event: Event,
  tracer: ReturnType<typeof trace.getTracer>,
  piiRedactor: any,
  activeSpans: Map<string, Span>,
  agentRegistry: Map<string, AgentInfo>,
  conversationContexts: Map<string, ConversationContext>
): Promise<void> {
  const message = (event as any).properties?.info;
  if (!message) return;

  const sessionId = message.sessionID;
  const conversationId = generateConversationId(sessionId);
  let convCtx = conversationContexts.get(conversationId);
  
  if (!convCtx) {
    convCtx = getOrCreateConversationContext(conversationId, sessionId, '', '');
    setBoundedMap(conversationContexts, conversationId, convCtx, MAX_PENDING);
  }

  // Handle assistant messages (LLM calls)
  if (message.role === 'assistant') {
    const span = messageMapper.updated(event as any, tracer, piiRedactor, activeSpans, agentRegistry);
    const tokens = message.tokens || { input: 0, output: 0 };
    hookState?.metrics?.recordInvocation({
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': message.modelID || 'unknown',
      'gen_ai.provider.name': message.providerID || 'unknown',
    });
    hookState?.metrics?.recordMessage({
      'gen_ai.session.id': sessionId,
      role: 'assistant',
    });
    hookState?.metrics?.recordModelUsage({
      'gen_ai.request.model': message.modelID || 'unknown',
      'gen_ai.provider.name': message.providerID || 'unknown',
    });
    if (tokens.input || tokens.output) {
      hookState?.metrics?.recordTokenUsage(tokens.input || 0, tokens.output || 0, {
        'gen_ai.request.model': message.modelID || 'unknown',
        'gen_ai.provider.name': message.providerID || 'unknown',
      });
      if (sessionIDTokenTotalsHas(hookState, sessionId)) {
        const prev = hookState!.sessionTokenTotals.get(sessionId) ?? 0;
        hookState!.sessionTokenTotals.set(sessionId, prev + (tokens.input || 0) + (tokens.output || 0));
      }
    }
    if (message.cost !== undefined && message.cost > 0) {
      hookState?.metrics?.recordCost(message.cost, {
        'gen_ai.request.model': message.modelID || 'unknown',
        'gen_ai.session.id': sessionId,
      });
    }
    hookState?.logs?.apiRequest('llm call', {
      sessionId,
      conversationId,
      agentName: message.agent || 'primary',
      operation: 'chat',
      model: message.modelID,
      provider: message.providerID,
    });
    // Keyed LLM span for chat.headers injection
    if (span) {
      setLlmRequestContext(sessionId, {
        span,
        provider: message.providerID,
        model: message.modelID,
        conversationId,
        agentId: generateAgentId(message.agent || 'primary', sessionId),
      });
    }
    if (span && hookState?.debug) {
      console.log(`[otel] LLM call: ${message.modelID} (${message.providerID})`);
    }
  }
}

function sessionIDTokenTotalsHas(state: EventHookState | null, sessionId: string): boolean {
  return !!state?.sessionTokenTotals;
}

async function handleMessagePartUpdated(
  event: Event,
  tracer: ReturnType<typeof trace.getTracer>,
  piiRedactor: any,
  activeSpans: Map<string, Span>,
  agentRegistry: Map<string, AgentInfo>,
  conversationContexts: Map<string, ConversationContext>
): Promise<void> {
  const { part } = (event as any).properties || {};
  if (!part) return;

  const sessionId = part.sessionID;
  const conversationId = generateConversationId(sessionId);
  const convCtx = conversationContexts.get(conversationId);
  if (!convCtx) return;

  // Handle subtask parts (delegation)
  if (part.type === 'subtask') {
    const delegation = delegationMapper.detectDelegation(
      { parts: [part] }, // Simplified - would need full message
      sessionId,
      convCtx
    );
    
    if (delegation) {
      const spans = delegationMapper.createDelegationSpans(
        delegation,
        sessionId,
        tracer,
        piiRedactor,
        agentRegistry
      );

      setBoundedMap(activeSpans, `${conversationId}:delegation:${delegation.toAgentId}`, spans.delegatorSpan, MAX_PENDING);
      setBoundedMap(activeSpans, `${conversationId}:agent:${delegation.toAgentId}`, spans.delegateeSpan, MAX_PENDING);
      setBoundedMap(activeSpans, `${conversationId}:context:${delegation.toAgentId}`, spans.contextSpan, MAX_PENDING);
      hookState?.metrics?.recordSubtask({
        'gen_ai.session.id': sessionId,
        from: delegation.fromAgentName,
        to: delegation.toAgentName,
      });
      
      if (hookState?.debug) {
        console.log(`[otel] Delegation: ${delegation.fromAgentName} -> ${delegation.toAgentName}`);
      }
    }
  }

  // Handle other parts via message mapper
  messageMapper.partUpdated(event as any, tracer, piiRedactor, activeSpans, agentRegistry);
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

export function disposeEventHook(): void {
  if (hookState) {
    // End all active spans
    for (const [key, span] of hookState.activeSpans.entries()) {
      try {
        span.end();
      } catch (e) {
        // Ignore
      }
    }
    hookState.activeSpans.clear();
    hookState.agentRegistry.clear();
    hookState.conversationContexts.clear();
    hookState.metrics = null;
    hookState.logs = null;
    hookState = null;
  }
}

// ─── Export ───────────────────────────────────────────────────────────────────

export function getHookState(): EventHookState | null {
  return hookState;
}