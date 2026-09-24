/**
 * opencode-otel-plugin - Event Mapper Tests
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { trace, SpanKind } from "@opentelemetry/api";

// Mock modules
vi.mock("../../src/otel/provider.js", () => ({
  enrichSpanAttributes: vi.fn((span: any, attrs: any, redactor: any) => {
    const redacted = redactor.redactAttributes(attrs);
    for (const [key, value] of Object.entries(redacted)) {
      if (value !== undefined && value !== null) {
        span.setAttribute(key, value as any);
      }
    }
  }),
}));

// ─── Mock Helpers ──────────────────────────────────────────────────────────────

function createMockSpan() {
  const attrs: Record<string, unknown> = {};
  const events: Array<{ name: string; attributes: Record<string, unknown> }> = [];
  return {
    spanContext: () => ({
      traceId: "0123456789abcdef0123456789abcdef",
      spanId: "0123456789abcdef",
      traceFlags: 1,
    }),
    setAttribute: vi.fn((key: string, value: unknown) => { attrs[key] = value; }),
    addEvent: vi.fn((name: string, eventAttrs?: Record<string, unknown>) => {
      events.push({ name, attributes: eventAttrs || {} });
    }),
    end: vi.fn(),
    setStatus: vi.fn(),
    _attrs: attrs,
    _events: events,
  };
}

function createMockTracer() {
  return {
    startSpan: vi.fn((_name: string, _opts?: any) => createMockSpan()),
  };
}

function createMockPiiRedactor() {
  return { redactAttributes: vi.fn((a: any) => ({ ...a })) };
}

const SESSION_ID = "session-1";

// generateConversationId("session-1") = "conv_" + "session-1" = "conv_session-1"
// generateAgentId("primary", "session-1") = "agent_" + hash("primary:session-1")
const CONV_ID = "conv_session-1";

// ─── Todo Mapper Tests ────────────────────────────────────────────────────────

describe("Todo Mapper", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("should create a todo span and add event to root span", async () => {
    const { mapTodoUpdated } = await import("../../src/mappers/todo.js");
    const tracer = createMockTracer();
    const activeSpans = new Map();
    const rootSpan = createMockSpan();
    activeSpans.set(`${CONV_ID}:root`, rootSpan);

    const event = {
      type: "todo.updated" as const,
      properties: {
        info: {
          id: "todo-1",
          sessionID: SESSION_ID,
          content: "Implement feature",
          status: "pending" as const,
          priority: "high" as const,
        },
      },
    };

    const result = mapTodoUpdated(event as any, tracer as any, activeSpans);
    expect(result).not.toBeNull();
    expect(rootSpan.addEvent).toHaveBeenCalledWith("todo.updated", expect.objectContaining({
      "todo.id": "todo-1",
      "todo.content": "Implement feature",
      "todo.status": "pending",
      "todo.priority": "high",
    }));
    expect(tracer.startSpan).toHaveBeenCalled();
  });

  it("should return null for missing info", async () => {
    const { mapTodoUpdated } = await import("../../src/mappers/todo.js");
    const tracer = createMockTracer();
    const activeSpans = new Map();
    activeSpans.set(`${CONV_ID}:root`, createMockSpan());

    const result = mapTodoUpdated({ type: "todo.updated", properties: {} } as any, tracer as any, activeSpans);
    expect(result).toBeNull();
  });

  it("should return null when root span not found", async () => {
    const { mapTodoUpdated } = await import("../../src/mappers/todo.js");
    const tracer = createMockTracer();
    const activeSpans = new Map();

    const result = mapTodoUpdated({
      type: "todo.updated",
      properties: { info: { id: "t1", sessionID: "no-session", content: "x", status: "pending" } },
    } as any, tracer as any, activeSpans);
    expect(result).toBeNull();
  });
});

// ─── Command Mapper Tests ─────────────────────────────────────────────────────

describe("Command Mapper", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("should create a command span with attributes", async () => {
    const { mapCommandExecuted } = await import("../../src/mappers/command.js");
    const tracer = createMockTracer();
    const piiRedactor = createMockPiiRedactor();
    const activeSpans = new Map();
    const rootSpan = createMockSpan();
    activeSpans.set(`${CONV_ID}:root`, rootSpan);

    const event = {
      type: "command.executed" as const,
      properties: {
        info: {
          id: "cmd-1",
          sessionID: SESSION_ID,
          command: "git status",
          args: ["--short"],
          exitCode: 0,
          durationMs: 150,
          workingDir: "/home/user/project",
        },
      },
    };

    const result = mapCommandExecuted(event as any, tracer as any, piiRedactor, activeSpans);
    expect(result).not.toBeNull();
    expect(tracer.startSpan).toHaveBeenCalledWith(
      "command.git",
      expect.objectContaining({ kind: SpanKind.INTERNAL })
    );
    expect(rootSpan.addEvent).toHaveBeenCalledWith("command.executed", expect.objectContaining({
      "command.name": "git status",
      "command.exit_code": 0,
      "command.success": true,
    }));
  });

  it("should return null for missing info", async () => {
    const { mapCommandExecuted } = await import("../../src/mappers/command.js");
    const tracer = createMockTracer();
    const piiRedactor = createMockPiiRedactor();
    const activeSpans = new Map();

    const result = mapCommandExecuted({ type: "command.executed", properties: {} } as any, tracer as any, piiRedactor, activeSpans);
    expect(result).toBeNull();
  });
});

// ─── File Mapper Tests ────────────────────────────────────────────────────────

describe("File Mapper", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("should create a file operation span", async () => {
    const { mapFileEdited } = await import("../../src/mappers/file.js");
    const tracer = createMockTracer();
    const piiRedactor = createMockPiiRedactor();
    const activeSpans = new Map();
    const rootSpan = createMockSpan();
    activeSpans.set(`${CONV_ID}:root`, rootSpan);

    const event = {
      type: "file.edited" as const,
      properties: {
        info: {
          id: "file-1",
          sessionID: SESSION_ID,
          path: "/home/user/project/src/index.ts",
          operation: "write" as const,
          size: 1024,
          linesAdded: 10,
          linesRemoved: 3,
        },
      },
    };

    const result = mapFileEdited(event as any, tracer as any, piiRedactor, activeSpans);
    expect(result).not.toBeNull();
    expect(tracer.startSpan).toHaveBeenCalledWith(
      "file.write",
      expect.objectContaining({ kind: SpanKind.INTERNAL })
    );
    expect(rootSpan.addEvent).toHaveBeenCalledWith("file.edited", expect.objectContaining({
      "file.path": "/home/user/project/src/index.ts",
      "file.operation": "write",
      "file.size_bytes": 1024,
      "file.lines_added": 10,
      "file.lines_removed": 3,
    }));
  });

  it("should return null for missing info", async () => {
    const { mapFileEdited } = await import("../../src/mappers/file.js");
    const tracer = createMockTracer();
    const piiRedactor = createMockPiiRedactor();
    const activeSpans = new Map();

    const result = mapFileEdited({ type: "file.edited", properties: {} } as any, tracer as any, piiRedactor, activeSpans);
    expect(result).toBeNull();
  });
});

// ─── MCP Mapper Tests ─────────────────────────────────────────────────────────

describe("MCP Mapper", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("should create an MCP tool call span and store in activeSpans", async () => {
    const { mapMCPToolCall } = await import("../../src/mappers/mcp.js");
    const tracer = createMockTracer();
    const piiRedactor = createMockPiiRedactor();
    const activeSpans = new Map();

    const event = {
      type: "mcp.tool.call" as const,
      properties: {
        info: {
          id: "mcp-1",
          sessionID: SESSION_ID,
          serverName: "filesystem",
          methodName: "read_file",
          callID: "call-abc",
          params: { path: "/test.txt" },
          durationMs: 50,
        },
      },
    };

    const result = mapMCPToolCall(event as any, tracer as any, piiRedactor, activeSpans);
    expect(result).not.toBeNull();
    expect(tracer.startSpan).toHaveBeenCalledWith(
      "mcp.tool.read_file",
      expect.objectContaining({ kind: SpanKind.CLIENT })
    );
    expect(activeSpans.has(`${CONV_ID}:mcp:call-abc`)).toBe(true);
  });

  it("should return null for missing info", async () => {
    const { mapMCPToolCall } = await import("../../src/mappers/mcp.js");
    const tracer = createMockTracer();
    const piiRedactor = createMockPiiRedactor();
    const activeSpans = new Map();

    const result = mapMCPToolCall({ type: "mcp.tool.call", properties: {} } as any, tracer as any, piiRedactor, activeSpans);
    expect(result).toBeNull();
  });

  it("should update span with result and end it", async () => {
    const { mapMCPToolCall, mapMCPToolResult } = await import("../../src/mappers/mcp.js");
    const tracer = createMockTracer();
    const piiRedactor = createMockPiiRedactor();
    const activeSpans = new Map();

    // Create call span
    mapMCPToolCall({
      type: "mcp.tool.call",
      properties: { info: { id: "mcp-2", sessionID: SESSION_ID, serverName: "fs", methodName: "write", callID: "call-xyz" } },
    } as any, tracer as any, piiRedactor, activeSpans);

    const span = activeSpans.get(`${CONV_ID}:mcp:call-xyz`);
    expect(span).toBeDefined();

    // Complete with result
    mapMCPToolResult({
      type: "mcp.tool.result",
      properties: { info: { id: "mcp-2", sessionID: SESSION_ID, serverName: "fs", methodName: "write", callID: "call-xyz", result: { ok: true }, durationMs: 100 } },
    } as any, activeSpans);

    expect(span!.setAttribute).toHaveBeenCalledWith("mcp.success", true);
    expect(span!.end).toHaveBeenCalled();
    expect(activeSpans.has(`${CONV_ID}:mcp:call-xyz`)).toBe(false);
  });

  it("should update span with error and end it", async () => {
    const { mapMCPToolCall, mapMCPToolError } = await import("../../src/mappers/mcp.js");
    const tracer = createMockTracer();
    const piiRedactor = createMockPiiRedactor();
    const activeSpans = new Map();

    mapMCPToolCall({
      type: "mcp.tool.call",
      properties: { info: { id: "mcp-3", sessionID: SESSION_ID, serverName: "fs", methodName: "delete", callID: "call-err" } },
    } as any, tracer as any, piiRedactor, activeSpans);

    const span = activeSpans.get(`${CONV_ID}:mcp:call-err`);

    mapMCPToolError({
      type: "mcp.tool.error",
      properties: { info: { id: "mcp-3", sessionID: SESSION_ID, serverName: "fs", methodName: "delete", callID: "call-err", error: { code: -1, message: "File not found" } } },
    } as any, activeSpans);

    expect(span!.setAttribute).toHaveBeenCalledWith("mcp.success", false);
    expect(span!.setAttribute).toHaveBeenCalledWith("error", true);
    expect(span!.setAttribute).toHaveBeenCalledWith("mcp.error_message", "File not found");
    expect(span!.end).toHaveBeenCalled();
    expect(activeSpans.has(`${CONV_ID}:mcp:call-err`)).toBe(false);
  });

  it("should handle result for non-existent span gracefully", async () => {
    const { mapMCPToolResult } = await import("../../src/mappers/mcp.js");
    const activeSpans = new Map();

    // Should not throw
    mapMCPToolResult({
      type: "mcp.tool.result",
      properties: { info: { id: "mcp-4", sessionID: SESSION_ID, serverName: "fs", methodName: "read", callID: "nonexistent" } },
    } as any, activeSpans);
  });
});

// ─── Memory Mapper Tests ──────────────────────────────────────────────────────

describe("Memory Mapper", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("should create a memory operation span", async () => {
    const { mapMemoryOperation } = await import("../../src/mappers/memory.js");
    const tracer = createMockTracer();
    const piiRedactor = createMockPiiRedactor();
    const activeSpans = new Map();
    const rootSpan = createMockSpan();
    activeSpans.set(`${CONV_ID}:root`, rootSpan);

    const event = {
      type: "memory.create" as const,
      properties: {
        info: {
          id: "mem-1",
          sessionID: SESSION_ID,
          operation: "create" as const,
          key: "user_preferences",
          version: 1,
          size: 256,
        },
      },
    };

    const result = mapMemoryOperation(event as any, tracer as any, piiRedactor, activeSpans);
    expect(result).not.toBeNull();
    expect(tracer.startSpan).toHaveBeenCalledWith(
      "memory.create",
      expect.objectContaining({ kind: SpanKind.INTERNAL })
    );
    expect(rootSpan.addEvent).toHaveBeenCalledWith("memory.operation", expect.objectContaining({
      "agent.memory.operation": "create",
    }));
  });

  it("should return null for missing info", async () => {
    const { mapMemoryOperation } = await import("../../src/mappers/memory.js");
    const tracer = createMockTracer();
    const piiRedactor = createMockPiiRedactor();
    const activeSpans = new Map();

    const result = mapMemoryOperation({ type: "memory.create", properties: {} } as any, tracer as any, piiRedactor, activeSpans);
    expect(result).toBeNull();
  });

  it("should handle value preview for small values", async () => {
    const { mapMemoryOperation } = await import("../../src/mappers/memory.js");
    const tracer = createMockTracer();
    const piiRedactor = createMockPiiRedactor();
    const activeSpans = new Map();
    activeSpans.set(`${CONV_ID}:root`, createMockSpan());

    const event = {
      type: "memory.create" as const,
      properties: {
        info: {
          id: "mem-2",
          sessionID: SESSION_ID,
          operation: "create" as const,
          key: "small_key",
          value: { theme: "dark" },
        },
      },
    };

    const result = mapMemoryOperation(event as any, tracer as any, piiRedactor, activeSpans);
    expect(result).not.toBeNull();
  });
});

// ─── Plan/Workflow Mapper Tests ───────────────────────────────────────────────

describe("Plan/Workflow Mapper", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("should create a plan span for plan.created", async () => {
    const { mapPlanEvent } = await import("../../src/mappers/plan.js");
    const tracer = createMockTracer();
    const piiRedactor = createMockPiiRedactor();
    const activeSpans = new Map();
    const rootSpan = createMockSpan();
    activeSpans.set(`${CONV_ID}:root`, rootSpan);

    const event = {
      type: "plan.created" as const,
      properties: {
        info: {
          id: "plan-1",
          sessionID: SESSION_ID,
          planID: "plan-abc",
          name: "Feature Implementation",
          description: "Implement new feature",
          status: "pending" as const,
          steps: [
            { id: "s1", name: "Design", status: "pending" as const },
            { id: "s2", name: "Implement", status: "pending" as const },
          ],
          totalSteps: 2,
        },
      },
    };

    const result = mapPlanEvent(event as any, tracer as any, piiRedactor, activeSpans);
    expect(result).not.toBeNull();
    expect(tracer.startSpan).toHaveBeenCalledWith(
      "plan.created",
      expect.objectContaining({ kind: SpanKind.INTERNAL })
    );
    expect(rootSpan.addEvent).toHaveBeenCalledWith("plan.updated", expect.objectContaining({
      "plan.id": "plan-abc",
      "plan.name": "Feature Implementation",
      "plan.status": "pending",
    }));
  });

  it("should end span on plan.completed", async () => {
    const { mapPlanEvent } = await import("../../src/mappers/plan.js");
    const tracer = createMockTracer();
    const piiRedactor = createMockPiiRedactor();
    const activeSpans = new Map();

    const event = {
      type: "plan.completed" as const,
      properties: {
        info: {
          id: "plan-2",
          sessionID: SESSION_ID,
          planID: "plan-xyz",
          name: "Done Plan",
          status: "completed" as const,
        },
      },
    };

    const result = mapPlanEvent(event as any, tracer as any, piiRedactor, activeSpans);
    expect(result).not.toBeNull();
    // The span should be ended for completed/failed events
    const mockSpan = tracer.startSpan.mock.results[0].value;
    expect(mockSpan.end).toHaveBeenCalled();
  });

  it("should create a workflow span for workflow.started", async () => {
    const { mapWorkflowEvent } = await import("../../src/mappers/plan.js");
    const tracer = createMockTracer();
    const piiRedactor = createMockPiiRedactor();
    const activeSpans = new Map();
    const rootSpan = createMockSpan();
    activeSpans.set(`${CONV_ID}:root`, rootSpan);

    const event = {
      type: "workflow.started" as const,
      properties: {
        info: {
          id: "wf-1",
          sessionID: SESSION_ID,
          workflowID: "wf-abc",
          name: "Deploy Pipeline",
          type: "sequential" as const,
          status: "running" as const,
          steps: [
            { id: "s1", name: "Build", type: "action" as const, status: "completed" as const },
            { id: "s2", name: "Test", type: "action" as const, status: "running" as const },
          ],
        },
      },
    };

    const result = mapWorkflowEvent(event as any, tracer as any, piiRedactor, activeSpans);
    expect(result).not.toBeNull();
    expect(tracer.startSpan).toHaveBeenCalledWith(
      "workflow.started",
      expect.objectContaining({ kind: SpanKind.INTERNAL })
    );
    expect(rootSpan.addEvent).toHaveBeenCalledWith("workflow.updated", expect.objectContaining({
      "workflow.id": "wf-abc",
      "workflow.name": "Deploy Pipeline",
      "workflow.type": "sequential",
      "workflow.status": "running",
    }));
  });

  it("should return null for missing plan info", async () => {
    const { mapPlanEvent } = await import("../../src/mappers/plan.js");
    const tracer = createMockTracer();
    const piiRedactor = createMockPiiRedactor();
    const activeSpans = new Map();

    const result = mapPlanEvent({ type: "plan.created", properties: {} } as any, tracer as any, piiRedactor, activeSpans);
    expect(result).toBeNull();
  });

  it("should return null for missing workflow info", async () => {
    const { mapWorkflowEvent } = await import("../../src/mappers/plan.js");
    const tracer = createMockTracer();
    const piiRedactor = createMockPiiRedactor();
    const activeSpans = new Map();

    const result = mapWorkflowEvent({ type: "workflow.started", properties: {} } as any, tracer as any, piiRedactor, activeSpans);
    expect(result).toBeNull();
  });

  it("should end workflow span on workflow.completed", async () => {
    const { mapWorkflowEvent } = await import("../../src/mappers/plan.js");
    const tracer = createMockTracer();
    const piiRedactor = createMockPiiRedactor();
    const activeSpans = new Map();

    const event = {
      type: "workflow.completed" as const,
      properties: {
        info: {
          id: "wf-2",
          sessionID: SESSION_ID,
          workflowID: "wf-xyz",
          name: "Done Workflow",
          type: "parallel" as const,
          status: "completed" as const,
        },
      },
    };

    const result = mapWorkflowEvent(event as any, tracer as any, piiRedactor, activeSpans);
    expect(result).not.toBeNull();
    const mockSpan = tracer.startSpan.mock.results[0].value;
    expect(mockSpan.end).toHaveBeenCalled();
  });
});
