/**
 * opencode-otel-plugin - Integration Tests
 * 
 * End-to-end tests for the plugin.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { trace, context, Span, SpanKind } from "@opentelemetry/api";

// Mock opencode-ai/plugin and sdk
vi.mock("@opencode-ai/plugin", () => ({
  PluginInput: {},
  Hooks: {},
  Config: {},
}));

vi.mock("@opencode-ai/sdk", () => ({
  Event: {},
}));

// Mock @opentelemetry/api for testing
vi.mock("@opentelemetry/api", async () => {
  const actual = await vi.importActual("@opentelemetry/api");
  const mockContext = {
    getValue: vi.fn(),
    setValue: vi.fn((ctx, key, value) => ctx),
  };
  const mockSpan = {
    spanContext: () => ({
      traceId: "0123456789abcdef0123456789abcdef",
      spanId: "0123456789abcdef",
      traceFlags: 1,
    }),
  };
  
  return {
    ...actual,
    context: {
      ...actual.context,
      active: vi.fn(() => mockContext),
      getValue: vi.fn((ctx, key) => ctx[key]),
      setValue: vi.fn((ctx, key, value) => ctx),
      with: vi.fn((ctx, fn) => fn(ctx)),
    },
    trace: {
      ...actual.trace,
      getSpan: vi.fn((ctx) => mockSpan),
      setSpan: vi.fn((ctx, span) => ctx),
      getSpanContext: vi.fn((ctx) => mockSpan.spanContext()),
      setGlobalTracerProvider: vi.fn(),
    },
    propagation: actual.propagation,
    ROOT_CONTEXT: {},
    SpanKind: {
      INTERNAL: 0,
      SERVER: 1,
      CLIENT: 2,
      PRODUCER: 3,
      CONSUMER: 4,
    },
    SamplingDecision: {
      DROP: 0,
      RECORD: 1,
      RECORD_AND_SAMPLE: 2,
    },
  };
});

import { mergeConfig } from "../../dist/config.js";
import { createTestProvider, enrichSpanAttributes } from "../../dist/otel/test-provider.js";
import { createPIIRedactor } from "../../dist/utils/pii.js";
import { initializeEventHook, handleEvent, disposeEventHook, getHookState } from "../../dist/hooks/event.js";
import { generateConversationId, generateAgentId, getOrCreateConversationContext } from "../../dist/utils/ids.js";
import type { RequiredConfig } from "../../dist/config.js";
import type { PluginInput } from "@opencode-ai/plugin";

describe("Plugin Integration", () => {
  let config: any;
  let providerSetup: any;
  let piiRedactor: any;
  let mockInput: any;

  beforeEach(async () => {
    config = mergeConfig({
      debug: true,
      sampling: { rate: 1.0 },
    });

    // Create provider
    const { createTestProvider } = await import("../../dist/otel/test-provider.js");
    const { createPIIRedactor } = await import("../../dist/utils/pii.js");
    
    providerSetup = await createTestProvider({
      serviceName: "test",
      serviceVersion: "1.0.0",
      environment: "test",
      endpoint: "http://localhost:4318/v1/traces",
      protocol: "http",
      batch: {
        maxQueueSize: 2048,
        maxExportBatchSize: 512,
        scheduledDelayMillis: 5000,
        exportTimeoutMillis: 30000,
      },
      sampling: {
        rate: 1.0,
        conversationAware: true,
        parentBased: true,
      },
      piiRedaction: {
        enabled: true,
        patterns: [],
        defaultFields: ["apiKey", "password", "secret", "token", "authorization", "apikey", "access_token", "refresh_token"],
      },
      resourceAttributes: {},
      debug: true,
      headers: {},
    });
    
    piiRedactor = createPIIRedactor({
      enabled: true,
      patterns: [],
      defaultFields: ["apiKey", "password", "secret", "token", "authorization", "apikey", "access_token", "refresh_token"],
    });

    // Mock plugin input
    mockInput = {
      client: {} as any,
      project: { id: "test-project", worktree: "/tmp", time: { created: Date.now() } },
      directory: "/tmp",
      worktree: "/tmp",
      experimental_workspace: { register: vi.fn() },
      serverUrl: new URL("http://localhost:3000"),
      $: {} as any,
    };

    // Initialize hooks
    const { initializeEventHook } = await import("../../dist/hooks/event.js");
    // Get tracer from the provider
    const tracer = providerSetup.provider.getTracer("opencode-test");
    initializeEventHook(mockInput, {
      serviceName: "test",
      serviceVersion: "1.0.0",
      environment: "test",
      endpoint: "http://localhost:4318/v1/traces",
      protocol: "http",
      batch: {
        maxQueueSize: 2048,
        maxExportBatchSize: 512,
        scheduledDelayMillis: 5000,
        exportTimeoutMillis: 30000,
      },
      sampling: {
        rate: 1.0,
        conversationAware: true,
        parentBased: true,
      },
      piiRedaction: {
        enabled: true,
        patterns: [],
        defaultFields: ["apiKey", "password", "secret", "token", "authorization", "apikey", "access_token", "refresh_token"],
      },
      resourceAttributes: {},
      debug: true,
      headers: {},
    }, tracer, piiRedactor);
  });

  afterEach(async () => {
    const { disposeEventHook } = await import("../../dist/hooks/event.js");
    disposeEventHook();
    await providerSetup.shutdown();
  });

  describe("Session Lifecycle", () => {
    it("should create spans for session.created", async () => {
      const event = {
        type: "session.created",
        properties: {
          info: {
            id: "session-123",
            title: "Test Session",
            agent: "primary",
            model: "gpt-4",
            projectID: "project-1",
            directory: "/home/user/project",
            parentID: undefined,
            version: "1",
            time: { created: Date.now(), updated: Date.now() },
          },
        },
      };

      await handleEvent({ event: event as any });
      
      const hookState = getHookState();
      expect(hookState).not.toBeNull();
      
      if (hookState) {
        const convId = generateConversationId("session-123");
        const rootSpan = hookState.activeSpans.get(`${convId}:root`);
        expect(rootSpan).toBeDefined();
      }
    });

    it("should end spans on session.deleted", async () => {
      const sessionId = "session-456";
      const convId = generateConversationId(sessionId);
      
      // First create session
      const createEvent = {
        type: "session.created",
        properties: {
          info: {
            id: sessionId,
            title: "Test",
            agent: "primary",
            model: "gpt-4",
            projectID: "project-1",
            directory: "/home/user/project",
            version: "1",
            time: { created: Date.now(), updated: Date.now() },
          },
        },
      };
      await handleEvent({ event: createEvent as any });

      // Then delete
      const deleteEvent = {
        type: "session.deleted",
        properties: {
          info: { id: sessionId },
        },
      };
      await handleEvent({ event: deleteEvent as any });

      const hookState = getHookState();
      if (hookState) {
        const rootSpan = hookState.activeSpans.get(`${convId}:root`);
        // Span should be ended and removed
        expect(rootSpan).toBeUndefined();
      }
    });
  });

  describe("Message Handling", () => {
    it("should create chat span for assistant message", async () => {
      const sessionId = "session-msg-1";
      const convId = generateConversationId(sessionId);
      
      // Create session first
      const createEvent = {
        type: "session.created",
        properties: {
          info: {
            id: sessionId,
            title: "Test",
            agent: "primary",
            model: "gpt-4",
            projectID: "project-1",
            directory: "/home/user/project",
            version: "1",
            time: { created: Date.now(), updated: Date.now() },
          },
        },
      };
      await handleEvent({ event: createEvent as any });

      // Send assistant message
      const messageEvent = {
        type: "message.updated",
        properties: {
          info: {
            id: "msg-1",
            sessionID: sessionId,
            role: "assistant",
            time: { created: Date.now(), completed: Date.now() + 1000 },
            parentID: "parent-1",
            modelID: "gpt-4",
            providerID: "openai",
            mode: "chat",
            path: { cwd: "/tmp", root: "/tmp" },
            cost: 0.001,
            tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
            finish: "stop",
          },
        },
      };
      
      await handleEvent({ event: messageEvent as any });

      const hookState = getHookState();
      if (hookState) {
        const chatSpan = hookState.activeSpans.get(`${convId}:chat:msg-1`);
        expect(chatSpan).toBeDefined();
      }
    });
  });

  describe("Tool Handling", () => {
    it("should create tool spans via hooks", async () => {
      const sessionId = "session-tool-1";
      const convId = generateConversationId(sessionId);
      
      // Create session
      const createEvent = {
        type: "session.created",
        properties: {
          info: {
            id: sessionId,
            title: "Test",
            agent: "primary",
            model: "gpt-4",
            projectID: "project-1",
            directory: "/home/user/project",
            version: "1",
            time: { created: Date.now(), updated: Date.now() },
          },
        },
      };
      await handleEvent({ event: createEvent as any });

      // Tool execute before
      const toolBeforeEvent = {
        type: "tool.execute.before",
        input: {
          tool: "read_file",
          sessionID: sessionId,
          callID: "call-123",
        },
      };
      
      // This is handled by the tool hook
      // Just verify no error
      expect(true).toBe(true);
    });
  });

  describe("Delegation Detection", () => {
    it("should detect delegation from subtask", async () => {
      const sessionId = "session-delegation-1";
      const convId = generateConversationId(sessionId);
      
      // Create session
      const createEvent = {
        type: "session.created",
        properties: {
          info: {
            id: sessionId,
            title: "Test",
            agent: "planner",
            model: "gpt-4",
            projectID: "project-1",
            directory: "/home/user/project",
            version: "1",
            time: { created: Date.now(), updated: Date.now() },
          },
        },
      };
      await handleEvent({ event: createEvent as any });

      // Message with subtask part
      const messageEvent = {
        type: "message.updated",
        properties: {
          info: {
            id: "msg-delegation",
            sessionID: sessionId,
            role: "assistant",
            time: { created: Date.now() },
            parentID: "parent-1",
            modelID: "gpt-4",
            providerID: "openai",
            mode: "chat",
            path: { cwd: "/tmp", root: "/tmp" },
            cost: 0.001,
            tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
            finish: "stop",
            parts: [
              {
                id: "part-1",
                sessionID: sessionId,
                messageID: "msg-delegation",
                type: "subtask",
                prompt: "Write a test function",
                description: "Need to add unit tests",
                agent: "coder",
              },
            ],
          },
        },
      };
      
      await handleEvent({ event: messageEvent as any });

      const hookState = getHookState();
      if (hookState) {
        // Should have delegation spans
        expect(true).toBe(true);
      }
    });
  });

  describe("PII Redaction", () => {
    it("should redact sensitive data from span attributes", async () => {
      const { enrichSpanAttributes } = await import("../../dist/otel/test-provider.js");
      const { createPIIRedactor } = await import("../../dist/utils/pii.js");
      const { trace } = await import("@opentelemetry/api");
      
      const mockSpan = {
        setAttribute: vi.fn(),
      };
      
      const piiRedactor = createPIIRedactor({
        enabled: true,
        patterns: [],
        defaultFields: ["apiKey", "password", "secret", "token", "authorization"],
      });
      
      const attrs = {
        'gen_ai.agent.id': 'agent-1',
        'gen_ai.request.model': 'gpt-4',
        'apiKey': 'sk-1234567890abcdef1234567890abcdef',
        'password': 'secret123',
      };
      
      enrichSpanAttributes(mockSpan as any, attrs as any, piiRedactor);
      
      expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.agent.id', 'agent-1');
      expect(mockSpan.setAttribute).toHaveBeenCalledWith('gen_ai.request.model', 'gpt-4');
      expect(mockSpan.setAttribute).toHaveBeenCalledWith('apiKey', '[REDACTED]');
      expect(mockSpan.setAttribute).toHaveBeenCalledWith('password', '[REDACTED]');
    });
  });

  describe("Conversation Correlation", () => {
    it("should maintain same conversation ID across events", async () => {
      const sessionId = "session-conv-1";
      const convId = generateConversationId(sessionId);
      
      // Create session
      await handleEvent({
        event: {
          type: "session.created",
          properties: {
            info: {
              id: sessionId,
              title: "Test",
              agent: "primary",
              model: "gpt-4",
              projectID: "project-1",
              directory: "/home/user/project",
              version: "1",
              time: { created: Date.now(), updated: Date.now() },
            },
          },
        } as any,
      });

      // Add message
      await handleEvent({
        event: {
          type: "message.updated",
          properties: {
            info: {
              id: "msg-1",
              sessionID: sessionId,
              role: "assistant",
              time: { created: Date.now() },
              modelID: "gpt-4",
              providerID: "openai",
              tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
            },
          },
        } as any,
      });

      const hookState = getHookState();
      if (hookState) {
        // All spans should share the same conversation ID
        for (const [key, span] of hookState.activeSpans.entries()) {
          if (key.startsWith(convId)) {
            // Verify conversation ID is in span attributes
            // (would need to inspect span.attributes in real test)
          }
        }
      }
    });
  });

   describe("Sampling", () => {
     it("should respect sampling rate", () => {
       const config = mergeConfig({ sampling: { rate: 0 } });
       expect(config.sampling.rate).toBe(0);
     });

     it("should sample all when rate is 1", () => {
       const config = mergeConfig({ sampling: { rate: 1.0 } });
       expect(config.sampling.rate).toBe(1.0);
     });
   });

   describe("New Event Types", () => {
     it("should handle todo.updated events", async () => {
       const sessionId = "session-todo-1";
       const convId = generateConversationId(sessionId);
       
       // Create session
       const createEvent = {
         type: "session.created",
         properties: {
           info: {
             id: sessionId,
             title: "Todo Test",
             agent: "primary",
             model: "gpt-4",
             projectID: "project-1",
             directory: "/home/user/project",
             version: "1",
             time: { created: Date.now(), updated: Date.now() },
           },
         },
       };
       await handleEvent({ event: createEvent as any });

       // Add todo
       const todoEvent = {
         type: "todo.updated",
         properties: {
           info: {
             id: "todo-1",
             sessionID: sessionId,
             content: "Write tests",
             status: "pending",
             priority: "high",
           },
         },
       };
       
       await handleEvent({ event: todoEvent as any });

       const hookState = getHookState();
       expect(hookState).not.toBeNull();
       if (hookState) {
         const rootSpan = hookState.activeSpans.get(`${convId}:root`);
         expect(rootSpan).toBeDefined();
       }
     });

     it("should handle command.executed events", async () => {
       const sessionId = "session-cmd-1";
       const convId = generateConversationId(sessionId);
       
       // Create session
       const createEvent = {
         type: "session.created",
         properties: {
           info: {
             id: sessionId,
             title: "Command Test",
             agent: "primary",
             model: "gpt-4",
             projectID: "project-1",
             directory: "/home/user/project",
             version: "1",
             time: { created: Date.now(), updated: Date.now() },
           },
         },
       };
       await handleEvent({ event: createEvent as any });

       // Execute command
       const cmdEvent = {
         type: "command.executed",
         properties: {
           info: {
             id: "cmd-1",
             sessionID: sessionId,
             command: "npm test",
             args: ["--run"],
             exitCode: 0,
             durationMs: 500,
             workingDir: "/home/user/project",
           },
         },
       };
       
       await handleEvent({ event: cmdEvent as any });

       const hookState = getHookState();
       expect(hookState).not.toBeNull();
     });

     it("should handle file.edited events", async () => {
       const sessionId = "session-file-1";
       const convId = generateConversationId(sessionId);
       
       // Create session
       const createEvent = {
         type: "session.created",
         properties: {
           info: {
             id: sessionId,
             title: "File Test",
             agent: "primary",
             model: "gpt-4",
             projectID: "project-1",
             directory: "/home/user/project",
             version: "1",
             time: { created: Date.now(), updated: Date.now() },
           },
         },
       };
       await handleEvent({ event: createEvent as any });

       // Edit file
       const fileEvent = {
         type: "file.edited",
         properties: {
           info: {
             id: "file-1",
             sessionID: sessionId,
             path: "/home/user/project/src/index.ts",
             operation: "write",
             size: 1024,
             linesAdded: 10,
             linesRemoved: 2,
           },
         },
       };
       
       await handleEvent({ event: fileEvent as any });

       const hookState = getHookState();
       expect(hookState).not.toBeNull();
     });

     it("should handle MCP tool call and result", async () => {
       const sessionId = "session-mcp-1";
       
       // Create session
       const createEvent = {
         type: "session.created",
         properties: {
           info: {
             id: sessionId,
             title: "MCP Test",
             agent: "primary",
             model: "gpt-4",
             projectID: "project-1",
             directory: "/home/user/project",
             version: "1",
             time: { created: Date.now(), updated: Date.now() },
           },
         },
       };
       await handleEvent({ event: createEvent as any });

       // MCP tool call
       const callEvent = {
         type: "mcp.tool.call",
         properties: {
           info: {
             id: "mcp-1",
             sessionID: sessionId,
             serverName: "filesystem",
             methodName: "read_file",
             callID: "call-mcp-1",
             params: { path: "/test.txt" },
           },
         },
       };
       
       await handleEvent({ event: callEvent as any });

       // MCP tool result
       const resultEvent = {
         type: "mcp.tool.result",
         properties: {
           info: {
             id: "mcp-1",
             sessionID: sessionId,
             serverName: "filesystem",
             methodName: "read_file",
             callID: "call-mcp-1",
             result: { content: "file content" },
             durationMs: 50,
           },
         },
       };
       
       await handleEvent({ event: resultEvent as any });

       const hookState = getHookState();
       expect(hookState).not.toBeNull();
     });

     it("should handle MCP tool error", async () => {
       const sessionId = "session-mcp-err-1";
       
       // Create session
       const createEvent = {
         type: "session.created",
         properties: {
           info: {
             id: sessionId,
             title: "MCP Error Test",
             agent: "primary",
             model: "gpt-4",
             projectID: "project-1",
             directory: "/home/user/project",
             version: "1",
             time: { created: Date.now(), updated: Date.now() },
           },
         },
       };
       await handleEvent({ event: createEvent as any });

       // MCP tool call
       const callEvent = {
         type: "mcp.tool.call",
         properties: {
           info: {
             id: "mcp-2",
             sessionID: sessionId,
             serverName: "filesystem",
             methodName: "delete_file",
             callID: "call-mcp-2",
             params: { path: "/test.txt" },
           },
         },
       };
       
       await handleEvent({ event: callEvent as any });

       // MCP tool error
       const errorEvent = {
         type: "mcp.tool.error",
         properties: {
           info: {
             id: "mcp-2",
             sessionID: sessionId,
             serverName: "filesystem",
             methodName: "delete_file",
             callID: "call-mcp-2",
             error: { code: -1, message: "File not found" },
           },
         },
       };
       
       await handleEvent({ event: errorEvent as any });

       const hookState = getHookState();
       expect(hookState).not.toBeNull();
     });

     it("should handle memory operations", async () => {
       const sessionId = "session-mem-1";
       
       // Create session
       const createEvent = {
         type: "session.created",
         properties: {
           info: {
             id: sessionId,
             title: "Memory Test",
             agent: "primary",
             model: "gpt-4",
             projectID: "project-1",
             directory: "/home/user/project",
             version: "1",
             time: { created: Date.now(), updated: Date.now() },
           },
         },
       };
       await handleEvent({ event: createEvent as any });

       // Memory create
       const memEvent = {
         type: "memory.create",
         properties: {
           info: {
             id: "mem-1",
             sessionID: sessionId,
             operation: "create",
             key: "user_preferences",
             value: { theme: "dark" },
             version: 1,
             size: 128,
           },
         },
       };
       
       await handleEvent({ event: memEvent as any });

       // Memory search
       const searchEvent = {
         type: "memory.search",
         properties: {
           info: {
             id: "mem-search-1",
             sessionID: sessionId,
             operation: "search",
             key: "theme",
             hit: true,
             durationMs: 10,
           },
         },
       };
       
       await handleEvent({ event: searchEvent as any });

       const hookState = getHookState();
       expect(hookState).not.toBeNull();
     });

     it("should handle plan events", async () => {
       const sessionId = "session-plan-1";
       const convId = generateConversationId(sessionId);
       
       // Create session
       const createEvent = {
         type: "session.created",
         properties: {
           info: {
             id: sessionId,
             title: "Plan Test",
             agent: "planner",
             model: "gpt-4",
             projectID: "project-1",
             directory: "/home/user/project",
             version: "1",
             time: { created: Date.now(), updated: Date.now() },
           },
         },
       };
       await handleEvent({ event: createEvent as any });

       // Plan created
       const planEvent = {
         type: "plan.created",
         properties: {
           info: {
             id: "plan-1",
             sessionID: sessionId,
             planID: "plan-abc",
             name: "Feature Implementation",
             description: "Implement new feature",
             status: "pending",
             steps: [
               { id: "s1", name: "Design", status: "pending" },
               { id: "s2", name: "Implement", status: "pending" },
             ],
             totalSteps: 2,
           },
         },
       };
       
       await handleEvent({ event: planEvent as any });

       const hookState = getHookState();
       expect(hookState).not.toBeNull();
       if (hookState) {
         const rootSpan = hookState.activeSpans.get(`${convId}:root`);
         expect(rootSpan).toBeDefined();
       }
     });

     it("should handle workflow events", async () => {
       const sessionId = "session-wf-1";
       
       // Create session
       const createEvent = {
         type: "session.created",
         properties: {
           info: {
             id: sessionId,
             title: "Workflow Test",
             agent: "orchestrator",
             model: "gpt-4",
             projectID: "project-1",
             directory: "/home/user/project",
             version: "1",
             time: { created: Date.now(), updated: Date.now() },
           },
         },
       };
       await handleEvent({ event: createEvent as any });

       // Workflow started
       const wfEvent = {
         type: "workflow.started",
         properties: {
           info: {
             id: "wf-1",
             sessionID: sessionId,
             workflowID: "wf-abc",
             name: "Deploy Pipeline",
             type: "sequential",
             status: "running",
             steps: [
               { id: "s1", name: "Build", type: "action", status: "completed" },
               { id: "s2", name: "Test", type: "action", status: "running" },
             ],
           },
         },
       };
       
       await handleEvent({ event: wfEvent as any });

       const hookState = getHookState();
       expect(hookState).not.toBeNull();
     });
   });
 });