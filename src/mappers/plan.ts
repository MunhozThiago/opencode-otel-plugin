/**
 * opencode-otel-plugin - Plan/Workflow Event Mapper
 * 
 * Maps plan and workflow events to OpenTelemetry spans.
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
  validateOptionalNumber,
  validateOptionalRecord,
  validateOptionalArray,
  validateOneOf,
  safeStringify,
  truncateString,
  addSpanEvent,
  endSpan,
  setSpanAttribute,
} from "./validation.js";

export interface PlanEvent {
  type: 'plan.created' | 'plan.updated' | 'plan.step' | 'plan.completed' | 'plan.failed';
  properties: {
    info: {
      id: string;
      sessionID: string;
      planID: string;
      name: string;
      description?: string;
      steps?: Array<{
        id: string;
        name: string;
        description?: string;
        status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';
        agent?: string;
        durationMs?: number;
      }>;
      currentStep?: number;
      totalSteps?: number;
      status: 'pending' | 'in_progress' | 'completed' | 'failed';
      metadata?: Record<string, unknown>;
      startTime?: number;
      endTime?: number;
    };
  };
}

export interface WorkflowEvent {
  type: 'workflow.started' | 'workflow.step' | 'workflow.completed' | 'workflow.failed';
  properties: {
    info: {
      id: string;
      sessionID: string;
      workflowID: string;
      name: string;
      type: 'sequential' | 'parallel' | 'conditional' | 'loop';
      currentStep?: string;
      steps?: Array<{
        id: string;
        name: string;
        type: 'action' | 'decision' | 'parallel' | 'subworkflow';
        status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
        agent?: string;
        durationMs?: number;
      }>;
      status: 'pending' | 'running' | 'completed' | 'failed';
      metadata?: Record<string, unknown>;
      startTime?: number;
      endTime?: number;
    };
  };
}

/**
 * Creates a plan span
 */
export function mapPlanEvent(
  event: PlanEvent,
  tracer: ReturnType<typeof trace.getTracer>,
  piiRedactor: any,
  activeSpans: Map<string, Span>
): Span | null {
  // ─── Step 1: Validate event structure ───────────────────
  const shapeValidation = validateEventShape(event, "plan.created|plan.updated|plan.step|plan.completed|plan.failed");
  if (!shapeValidation.valid) {
    try {
      console.warn("[otel] Plan mapper validation failed:", shapeValidation.errors);
    } catch {
      // Ignore logging errors
    }
    return null;
  }

  const plan = event.properties?.info;
  if (!plan) return null;

  // ─── Step 2: Validate plan fields ───────────────────────
  const errors: string[] = [];
  const sessionId = validateSessionId(plan.sessionID);
  const planID = validateId(plan.planID, "plan.id", errors);
  const name = validateId(plan.name, "plan.name", errors);
  const description = validateOptionalString(plan.description, "plan.description", errors);
  const status = validateOneOf(
    plan.status,
    ["pending", "in_progress", "completed", "failed"],
    "plan.status",
    errors
  );
  const currentStep = validateOptionalNumber(plan.currentStep, "plan.currentStep", errors);
  const totalSteps = validateOptionalNumber(plan.totalSteps, "plan.totalSteps", errors);
  const metadata = validateOptionalRecord(plan.metadata, "plan.metadata", errors);
  const startTime = validateOptionalNumber(plan.startTime, "plan.startTime", errors);
  const endTime = validateOptionalNumber(plan.endTime, "plan.endTime", errors);
  const steps = validateOptionalArray(plan.steps, "plan.steps", errors);

  if (errors.length > 0) {
    try {
      console.warn("[otel] Plan mapper validation failed:", errors);
    } catch {
      // Ignore logging errors
    }
    return null;
  }

  // ─── Step 3: Create span with error boundary ───────────
  try {
    const conversationId = generateConversationId(sessionId.value!);
    const agentId = generateAgentId('primary', sessionId.value!);

    const spanName = `plan.${event.type.replace('plan.', '')}`;
    const baseAttrs = createBaseAttributes(sessionId.value!, agentId, 'primary', conversationId, 'plan', {
      agentDescription: 'Plan executor',
      sessionId: sessionId.value!,
    });
    
    const planAttrs: Attributes = {
      'plan.id': planID!.value,
      'plan.name': name!.value,
      'plan.session_id': sessionId.value!,
      'plan.status': status!,
    };

    if (description) planAttrs['plan.description'] = description;
    if (currentStep !== undefined) planAttrs['plan.current_step'] = currentStep;
    if (totalSteps !== undefined) planAttrs['plan.total_steps'] = totalSteps;
    if (steps) {
      planAttrs['plan.steps'] = safeStringify(steps);
      planAttrs['plan.steps_count'] = Array.isArray(steps) ? steps.length : 0;
    }
    if (metadata) planAttrs['plan.metadata'] = safeStringify(metadata);
    if (startTime !== undefined) planAttrs['plan.start_time'] = startTime;
    if (endTime !== undefined) planAttrs['plan.end_time'] = endTime;

    // Merge plan attrs into base attrs
    const mergedAttrs = { ...baseAttrs };
    for (const [key, value] of Object.entries(planAttrs)) {
      (mergedAttrs as Record<string, unknown>)[key] = value;
    }

    const span = tracer.startSpan(spanName, {
      kind: SpanKind.INTERNAL,
      attributes: flattenAttributes(mergedAttrs),
    });

    enrichSpanAttributes(span, mergedAttrs as GenAIAttributes, piiRedactor);

    // Add as event to root span
    const rootSpan = activeSpans.get(`${conversationId}:root`);
    addSpanEvent(rootSpan, 'plan.updated', planAttrs);

    if (event.type === 'plan.completed' || event.type === 'plan.failed') {
      endSpan(span);
    }

    return span;
  } catch (error) {
    try {
      console.warn("[otel] Plan mapper failed:", error);
    } catch {
      // Ignore logging errors
    }
    return null;
  }
}

/**
 * Creates a workflow span
 */
export function mapWorkflowEvent(
  event: WorkflowEvent,
  tracer: ReturnType<typeof trace.getTracer>,
  piiRedactor: any,
  activeSpans: Map<string, Span>
): Span | null {
  // ─── Step 1: Validate event structure ───────────────────
  const shapeValidation = validateEventShape(event, "workflow.started|workflow.step|workflow.completed|workflow.failed");
  if (!shapeValidation.valid) {
    try {
      console.warn("[otel] Workflow mapper validation failed:", shapeValidation.errors);
    } catch {
      // Ignore logging errors
    }
    return null;
  }

  const workflow = event.properties?.info;
  if (!workflow) return null;

  // ─── Step 2: Validate workflow fields ───────────────────
  const errors: string[] = [];
  const sessionId = validateSessionId(workflow.sessionID);
  const workflowID = validateId(workflow.workflowID, "workflow.id", errors);
  const name = validateId(workflow.name, "workflow.name", errors);
  const type = validateOneOf(
    workflow.type,
    ["sequential", "parallel", "conditional", "loop"],
    "workflow.type",
    errors
  );
  const status = validateOneOf(
    workflow.status,
    ["pending", "running", "completed", "failed"],
    "workflow.status",
    errors
  );
  const currentStep = validateOptionalString(workflow.currentStep, "workflow.currentStep", errors);
  const metadata = validateOptionalRecord(workflow.metadata, "workflow.metadata", errors);
  const startTime = validateOptionalNumber(workflow.startTime, "workflow.startTime", errors);
  const endTime = validateOptionalNumber(workflow.endTime, "workflow.endTime", errors);
  const steps = validateOptionalArray(workflow.steps, "workflow.steps", errors);

  if (errors.length > 0) {
    try {
      console.warn("[otel] Workflow mapper validation failed:", errors);
    } catch {
      // Ignore logging errors
    }
    return null;
  }

  // ─── Step 3: Create span with error boundary ───────────
  try {
    const conversationId = generateConversationId(sessionId.value!);
    const agentId = generateAgentId('primary', sessionId.value!);

    const spanName = `workflow.${event.type.replace('workflow.', '')}`;
    const baseAttrs = createBaseAttributes(sessionId.value!, agentId, 'primary', conversationId, 'workflow', {
      agentDescription: 'Workflow executor',
      sessionId: sessionId.value!,
    });
    
    const workflowAttrs: Attributes = {
      'workflow.id': workflowID!.value,
      'workflow.name': name!.value,
      'workflow.type': type!,
      'workflow.session_id': sessionId.value!,
      'workflow.status': status!,
    };

    if (currentStep) workflowAttrs['workflow.current_step'] = currentStep;
    if (steps) {
      workflowAttrs['workflow.steps'] = safeStringify(steps);
      workflowAttrs['workflow.steps_count'] = steps.length;
    }
    if (metadata) workflowAttrs['workflow.metadata'] = safeStringify(metadata);
    if (startTime !== undefined) workflowAttrs['workflow.start_time'] = startTime;
    if (endTime !== undefined) workflowAttrs['workflow.end_time'] = endTime;

    // Merge workflow attrs into base attrs
    const mergedAttrs = { ...baseAttrs };
    for (const [key, value] of Object.entries(workflowAttrs)) {
      (mergedAttrs as Record<string, unknown>)[key] = value;
    }

    const span = tracer.startSpan(spanName, {
      kind: SpanKind.INTERNAL,
      attributes: flattenAttributes(mergedAttrs),
    });

    enrichSpanAttributes(span, mergedAttrs as GenAIAttributes, piiRedactor);

    // Add as event to root span
    const rootSpan = activeSpans.get(`${conversationId}:root`);
    addSpanEvent(rootSpan, 'workflow.updated', workflowAttrs);

    if (event.type === 'workflow.completed' || event.type === 'workflow.failed') {
      endSpan(span);
    }

    return span;
  } catch (error) {
    try {
      console.warn("[otel] Workflow mapper failed:", error);
    } catch {
      // Ignore logging errors
    }
    return null;
  }
}