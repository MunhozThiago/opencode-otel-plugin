/**
 * opencode-otel-plugin - Command Event Mapper
 * 
 * Maps opencode command events to OpenTelemetry spans.
 */

import { trace, SpanKind } from "@opentelemetry/api";
import type { Span, Attributes } from "@opentelemetry/api";
import type { GenAIAttributes } from "../types.js";
import { createBaseAttributes, flattenAttributes } from "../otel/semantic-conventions.js";
import { generateConversationId, generateAgentId } from "../utils/ids.js";
import { enrichSpanAttributes } from "../otel/provider.js";
import {
  validateEventShape,
  validateSessionId,
  validateId,
  validateOptionalString,
  validateOptionalStringArray,
  validateOptionalNumber,
  validateOptionalRecord,
  validateOneOf,
  safeStringify,
  truncateString,
  addSpanEvent,
  endSpan,
  setSpanAttribute,
} from "./validation.js";

export interface CommandEvent {
  type: 'command.executed';
  properties: {
    info: {
      id: string;
      sessionID: string;
      command: string;
      args?: string[];
      exitCode?: number;
      durationMs?: number;
      stdout?: string;
      stderr?: string;
      workingDir?: string;
      startTime?: number;
      endTime?: number;
    };
  };
}

/**
 * Creates a command execution span
 */
export function mapCommandExecuted(
  event: CommandEvent,
  tracer: ReturnType<typeof trace.getTracer>,
  piiRedactor: any,
  activeSpans: Map<string, Span>
): Span | null {
  // ─── Step 1: Validate event structure ───────────────────────────
  const shapeValidation = validateEventShape(event, "command.executed");
  if (!shapeValidation.valid) {
    try {
      console.warn("[otel] Command mapper validation failed:", shapeValidation.errors);
    } catch {
      // Ignore logging errors
    }
    return null;
  }

  const cmd = event.properties?.info;
  if (!cmd) return null;

  // ─── Step 2: Validate command fields ─────────────────────────────
  const errors: string[] = [];
  const sessionId = validateSessionId(cmd.sessionID);
  const command = validateOptionalString(cmd.command, "command", errors);
  const args = validateOptionalStringArray(cmd.args, "command.args", errors);
  const exitCode = validateOptionalNumber(cmd.exitCode, "command.exitCode", errors);
  const durationMs = validateOptionalNumber(cmd.durationMs, "command.durationMs", errors);
  const stdout = validateOptionalString(cmd.stdout, "command.stdout", errors);
  const stderr = validateOptionalString(cmd.stderr, "command.stderr", errors);
  const workingDir = validateOptionalString(cmd.workingDir, "command.workingDir", errors);
  const startTime = validateOptionalNumber(cmd.startTime, "command.startTime", errors);
  const endTime = validateOptionalNumber(cmd.endTime, "command.endTime", errors);

  if (errors.length > 0) {
    try {
      console.warn("[otel] Command mapper validation failed:", errors);
    } catch {
      // Ignore logging errors
    }
    return null;
  }

  // ─── Step 3: Create span with error boundary ─────────────────────────
  try {
    const conversationId = generateConversationId(sessionId.value!);
    const agentId = generateAgentId('primary', sessionId.value!);

    const spanName = `command.${command!.split(' ')[0]}`;
    const baseAttrs = createBaseAttributes(sessionId.value!, agentId, 'primary', conversationId, 'command', {
      agentDescription: 'Command executor',
      sessionId: sessionId.value!,
    });
    
    const cmdAttrs: Attributes = {
      'command.name': command!,
      'command.session_id': sessionId.value!,
    };

    if (args) cmdAttrs['command.args'] = safeStringify(args);
    if (exitCode !== undefined) {
      cmdAttrs['command.exit_code'] = exitCode;
      cmdAttrs['command.success'] = exitCode === 0;
    }
    if (durationMs !== undefined) cmdAttrs['command.duration_ms'] = durationMs;
    if (workingDir) cmdAttrs['command.working_dir'] = workingDir;
    if (startTime !== undefined) cmdAttrs['command.start_time'] = startTime;
    if (endTime !== undefined) cmdAttrs['command.end_time'] = endTime;

    if (stdout) {
      cmdAttrs['command.stdout'] = truncateString(stdout, 10000);
    }

    if (stderr) {
      cmdAttrs['command.stderr'] = truncateString(stderr, 10000);
    }

    // Merge cmd attrs into base attrs
    const mergedAttrs = { ...baseAttrs };
    for (const [key, value] of Object.entries(cmdAttrs)) {
      (mergedAttrs as Record<string, unknown>)[key] = value;
    }

    const span = tracer.startSpan(spanName, {
      kind: SpanKind.INTERNAL,
      attributes: flattenAttributes(mergedAttrs),
    });

    enrichSpanAttributes(span, mergedAttrs as GenAIAttributes, piiRedactor);

    // Add as event to root span
    const rootSpan = activeSpans.get(`${conversationId}:root`);
    addSpanEvent(rootSpan, 'command.executed', cmdAttrs);

    endSpan(span);
    return span;
  } catch (error) {
    try {
      console.warn("[otel] Command mapper failed:", error);
    } catch {
      // Ignore logging errors
    }
    return null;
  }
}