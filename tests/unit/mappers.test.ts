/**
 * opencode-otel-plugin - Mappers Tests
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { trace, Span, SpanKind } from "@opentelemetry/api";
import {
  addChatAttributes,
  addToolAttributes,
  addDelegationAttributes,
  addContextPackageAttributes,
  addMemoryAttributes,
  addContextWindowAttributes,
  addErrorAttributes,
  addSessionAttributes,
  createBaseAttributes,
  flattenAttributes,
  spanTypeToSpanKind,
  spanTypeToOperationName,
} from "../../dist/otel/semantic-conventions.js";

describe("Semantic Conventions", () => {
  describe("spanTypeToSpanKind", () => {
    it("should map agent spans to CLIENT", () => {
      expect(spanTypeToSpanKind('agent.root')).toBe(SpanKind.CLIENT);
      expect(spanTypeToSpanKind('agent.sub')).toBe(SpanKind.CLIENT);
      expect(spanTypeToSpanKind('delegation')).toBe(SpanKind.CLIENT);
    });

    it("should map chat to CLIENT", () => {
      expect(spanTypeToSpanKind('chat')).toBe(SpanKind.CLIENT);
    });

    it("should map tool spans to CLIENT", () => {
      expect(spanTypeToSpanKind('tool')).toBe(SpanKind.CLIENT);
      expect(spanTypeToSpanKind('mcp.tool')).toBe(SpanKind.CLIENT);
    });

    it("should map plan to INTERNAL", () => {
      expect(spanTypeToSpanKind('plan')).toBe(SpanKind.INTERNAL);
    });

    it("should map memory spans to INTERNAL", () => {
      expect(spanTypeToSpanKind('memory.create')).toBe(SpanKind.INTERNAL);
      expect(spanTypeToSpanKind('memory.search')).toBe(SpanKind.INTERNAL);
      expect(spanTypeToSpanKind('memory.update')).toBe(SpanKind.INTERNAL);
      expect(spanTypeToSpanKind('memory.delete')).toBe(SpanKind.INTERNAL);
    });

    it("should map workflow and session to INTERNAL", () => {
      expect(spanTypeToSpanKind('workflow')).toBe(SpanKind.INTERNAL);
      expect(spanTypeToSpanKind('session')).toBe(SpanKind.INTERNAL);
      expect(spanTypeToSpanKind('compaction')).toBe(SpanKind.INTERNAL);
    });
  });

  describe("spanTypeToOperationName", () => {
    it("should return correct operation names", () => {
      expect(spanTypeToOperationName('agent.root')).toBe('invoke_agent');
      expect(spanTypeToOperationName('agent.sub')).toBe('invoke_agent');
      expect(spanTypeToOperationName('delegation')).toBe('invoke_agent');
      expect(spanTypeToOperationName('chat')).toBe('chat');
      expect(spanTypeToOperationName('tool')).toBe('execute_tool');
      expect(spanTypeToOperationName('mcp.tool')).toBe('execute_tool');
      expect(spanTypeToOperationName('plan')).toBe('plan');
      expect(spanTypeToOperationName('memory.create')).toBe('create_memory');
      expect(spanTypeToOperationName('memory.search')).toBe('search_memory');
      expect(spanTypeToOperationName('memory.update')).toBe('update_memory');
      expect(spanTypeToOperationName('memory.delete')).toBe('delete_memory');
      expect(spanTypeToOperationName('workflow')).toBe('invoke_workflow');
    });
  });

  describe("flattenAttributes", () => {
    it("should remove undefined and null values", () => {
      const attrs = {
        a: "value",
        b: undefined,
        c: null,
        d: 123,
      };
      const result = flattenAttributes(attrs as any);
      expect(result.a).toBe("value");
      expect(result.b).toBeUndefined();
      expect(result.c).toBeUndefined();
      expect(result.d).toBe(123);
    });
  });

  describe("createBaseAttributes", () => {
    it("should create base GenAI attributes", () => {
      const attrs = createBaseAttributes("session-1", "agent-1", "Test Agent", "conv-1", "chat", {
        agentDescription: "A test agent",
        sessionId: "session-1",
        workflowPattern: "sequential",
      });
      
      expect(attrs['gen_ai.agent.id']).toBe("agent-1");
      expect(attrs['gen_ai.agent.name']).toBe("Test Agent");
      expect(attrs['gen_ai.conversation.id']).toBe("conv-1");
      expect(attrs['gen_ai.operation.name']).toBe("chat");
      expect(attrs['gen_ai.agent.description']).toBe("A test agent");
      expect(attrs['gen_ai.session.id']).toBe("session-1");
      expect(attrs['agent.workflow.pattern']).toBe("sequential");
    });
  });

  describe("addChatAttributes", () => {
    it("should add chat attributes", () => {
      const base = { 'gen_ai.agent.id': 'agent-1' } as any;
      const result = addChatAttributes(base, {
        requestModel: "gpt-4",
        providerName: "openai",
        system: "openai",
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 10,
        cacheReadTokens: 5,
        cacheWriteTokens: 2,
      });
      
      expect(result['gen_ai.request.model']).toBe("gpt-4");
      expect(result['gen_ai.response.model']).toBe("gpt-4");
      expect(result['gen_ai.provider.name']).toBe("openai");
      expect(result['gen_ai.system']).toBe("openai");
      expect(result['gen_ai.token_usage.input']).toBe(100);
      expect(result['gen_ai.token_usage.output']).toBe(50);
      expect(result['gen_ai.token_usage.total']).toBe(167); // 100+50+10+5+2
    });
  });

  describe("addToolAttributes", () => {
    it("should add tool attributes", () => {
      const base = { 'gen_ai.agent.id': 'agent-1' } as any;
      const result = addToolAttributes(base, {
        toolName: "read_file",
        toolCallId: "call-123",
        input: { path: "/test.txt" },
        output: "file content",
        durationMs: 150,
      });
      
      expect(result['gen_ai.tool.name']).toBe("read_file");
      expect(result['gen_ai.tool.call_id']).toBe("call-123");
      expect(result['gen_ai.tool.input']).toBe('{"path":"/test.txt"}');
      expect(result['gen_ai.tool.output']).toBe("file content");
      expect(result['gen_ai.tool.duration_ms']).toBe(150);
    });

    it("should add MCP attributes when isMCP", () => {
      const base = { 'gen_ai.agent.id': 'agent-1' } as any;
      const result = addToolAttributes(base, {
        toolName: "mcp__read_file",
        toolCallId: "call-123",
        isMCP: true,
        mcpServerName: "filesystem",
        mcpSessionId: "mcp-session-1",
      });
      
      expect(result['mcp.method.name']).toBe("mcp__read_file");
      expect(result['mcp.server.name']).toBe("filesystem");
      expect(result['mcp.session.id']).toBe("mcp-session-1");
    });

    it("should add error attribute", () => {
      const base = { 'gen_ai.agent.id': 'agent-1' } as any;
      const result = addToolAttributes(base, {
        toolName: "read_file",
        toolCallId: "call-123",
        error: "File not found",
      });
      
      expect(result['gen_ai.tool.error']).toBe("File not found");
    });
  });

  describe("addDelegationAttributes", () => {
    it("should add delegation attributes", () => {
      const base = { 'gen_ai.agent.id': 'agent-1' } as any;
      const result = addDelegationAttributes(base, {
        fromAgentId: "agent-1",
        fromAgentName: "Planner",
        toAgentId: "agent-2",
        toAgentName: "Coder",
        rationale: "Need to implement feature",
        contextTokensSent: 5000,
        contextTokensReceived: 4500,
        truncated: true,
      });
      
      expect(result['agent.delegation.rationale']).toBe("Need to implement feature");
      expect(result['agent.delegation.from_agent_id']).toBe("agent-1");
      expect(result['agent.delegation.to_agent_id']).toBe("agent-2");
      expect(result['agent.context.package.tokens_sent']).toBe(5000);
      expect(result['agent.context.package.tokens_received']).toBe(4500);
      expect(result['agent.context.package.truncated']).toBe(true);
    });
  });

  describe("addContextPackageAttributes", () => {
    it("should add context package attributes", () => {
      const base = { 'gen_ai.agent.id': 'agent-1' } as any;
      const result = addContextPackageAttributes(base, {
        tokensSent: 5000,
        tokensReceived: 4500,
        truncated: true,
        diff: '{"added":1}',
      });
      
      expect(result['agent.context.package.tokens_sent']).toBe(5000);
      expect(result['agent.context.package.tokens_received']).toBe(4500);
      expect(result['agent.context.package.truncated']).toBe(true);
      expect(result['agent.context.package.diff']).toBe('{"added":1}');
    });
  });

  describe("addMemoryAttributes", () => {
    it("should add memory attributes", () => {
      const base = { 'gen_ai.agent.id': 'agent-1' } as any;
      const result = addMemoryAttributes(base, {
        operation: "create",
        key: "user_preferences",
        keyHash: "mem_abc12345",
        version: 1,
      });
      
      expect(result['agent.memory.operation']).toBe("create");
      expect(result['agent.memory.key']).toBe("mem_abc12345");
      expect(result['agent.memory.version']).toBe(1);
    });
  });

  describe("addContextWindowAttributes", () => {
    it("should add context window attributes", () => {
      const base = { 'gen_ai.agent.id': 'agent-1' } as any;
      const result = addContextWindowAttributes(base, {
        fillPercent: 75,
        tokensAvailable: 50000,
        tokensUsed: 150000,
        maxTokens: 200000,
      });
      
      expect(result['agent.context.window.fill_percent']).toBe(75);
      expect(result['agent.context.window.tokens_available']).toBe(50000);
      expect(result['agent.context.window.tokens_used']).toBe(150000);
      expect(result['agent.context.window.max_tokens']).toBe(200000);
    });
  });

  describe("addErrorAttributes", () => {
    it("should add error attributes from Error object", () => {
      const attrs = { 'gen_ai.agent.id': 'agent-1' };
      const error = new Error("Test error");
      error.stack = "Error: Test error\n    at test";
      
      const result = addErrorAttributes(attrs, error, "CustomError");
      
      expect(result['error.type']).toBe("CustomError");
      expect(result['error.message']).toBe("Test error");
      expect(result['error.stack']).toContain("Test error");
    });

    it("should add error attributes from string", () => {
      const attrs = { 'gen_ai.agent.id': 'agent-1' };
      const result = addErrorAttributes(attrs, "String error", "StringError");
      
      expect(result['error.type']).toBe("StringError");
      expect(result['error.message']).toBe("String error");
    });
  });

  describe("addSessionAttributes", () => {
    it("should add session attributes", () => {
      const base = { 'gen_ai.agent.id': 'agent-1' } as any;
      const result = addSessionAttributes(base, {
        sessionId: "session-123",
        title: "Test Session",
        projectId: "project-456",
        directory: "/home/user/project",
        parentSessionId: "parent-789",
      });
      
      expect(result['session.id']).toBe("session-123");
      expect(result['session.title']).toBe("Test Session");
      expect(result['session.project_id']).toBe("project-456");
      expect(result['session.directory']).toBe("/home/user/project");
      expect(result['session.parent_id']).toBe("parent-789");
    });
  });
});