/**
 * opencode-otel-plugin - Delegation Mapper Tests
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { trace, Span, SpanKind } from "@opentelemetry/api";
import {
  detectDelegation,
  updateContextPackageReceived,
  createDelegationSpans,
  calculateContextFidelity,
  addContextFidelityAttributes,
  trackHandoffChain,
  getHandoffChain,
} from "../../dist/mappers/delegation.js";
import { generateAgentId, generateConversationId, getOrCreateConversationContext, clearConversationContext } from "../../dist/utils/ids.js";

describe("Delegation Mapper", () => {
  let mockTracer: ReturnType<typeof trace.getTracer>;
  let mockPiiRedactor: any;
  let agentRegistry: Map<string, any>;

  beforeEach(() => {
    vi.clearAllMocks();
    
    // Create mock tracer
    mockTracer = {
      startSpan: vi.fn().mockReturnValue({
        setAttribute: vi.fn(),
        addEvent: vi.fn(),
        end: vi.fn(),
        spanContext: () => ({
          traceId: "0123456789abcdef0123456789abcdef",
          spanId: "0123456789abcdef",
          traceFlags: 1,
        }),
      }),
    } as any;

    mockPiiRedactor = {
      redactAttributes: vi.fn((attrs) => attrs),
    };

    agentRegistry = new Map();
    clearConversationContext("conv-test");
  });

  describe("detectDelegation", () => {
    it("should detect delegation from subtask part", () => {
      const convCtx = getOrCreateConversationContext("conv-test", "session-1", "agent-planner", "Planner");
      
      const message = {
        parts: [
          { type: "text", text: "I'll delegate this" },
          { type: "subtask", prompt: "Write a function", description: "Need coding help", agent: "Coder" },
        ],
      };

      const delegation = detectDelegation(message, "session-1", convCtx);
      
      expect(delegation).not.toBeNull();
      expect(delegation?.fromAgentName).toBe("Planner");
      expect(delegation?.toAgentName).toBe("Coder");
      expect(delegation?.rationale).toBe("Need coding help");
      expect(delegation?.contextTokensSent).toBeGreaterThan(0);
    });

    it("should return null when no subtask part", () => {
      const convCtx = getOrCreateConversationContext("conv-test", "session-1", "agent-1", "Agent");
      
      const message = {
        parts: [
          { type: "text", text: "Just a regular message" },
        ],
      };

      const delegation = detectDelegation(message, "session-1", convCtx);
      expect(delegation).toBeNull();
    });

    it("should return null when subtask has no agent", () => {
      const convCtx = getOrCreateConversationContext("conv-test", "session-1", "agent-1", "Agent");
      
      const message = {
        parts: [
          { type: "subtask", prompt: "Do something", description: "Test" },
        ],
      };

      const delegation = detectDelegation(message, "session-1", convCtx);
      expect(delegation).toBeNull();
    });
  });

  describe("updateContextPackageReceived", () => {
    it("should update received tokens and truncated flag", () => {
      const delegation = {
        fromAgentId: "agent-1",
        fromAgentName: "Planner",
        toAgentId: "agent-2",
        toAgentName: "Coder",
        rationale: "Test",
        contextTokensSent: 5000,
        contextTokensReceived: 5000,
        truncated: false,
      };

      const updated = updateContextPackageReceived(delegation, 4000);
      
      expect(updated.contextTokensReceived).toBe(4000);
      expect(updated.truncated).toBe(true);
    });

    it("should not truncate when received >= sent", () => {
      const delegation = {
        fromAgentId: "agent-1",
        fromAgentName: "Planner",
        toAgentId: "agent-2",
        toAgentName: "Coder",
        rationale: "Test",
        contextTokensSent: 5000,
        contextTokensReceived: 5000,
        truncated: false,
      };

      const updated = updateContextPackageReceived(delegation, 5000);
      
      expect(updated.contextTokensReceived).toBe(5000);
      expect(updated.truncated).toBe(false);
    });
  });

  describe("createDelegationSpans", () => {
    it("should create three spans", () => {
      const delegation = {
        fromAgentId: "agent-1",
        fromAgentName: "Planner",
        toAgentId: "agent-2",
        toAgentName: "Coder",
        rationale: "Test delegation",
        contextTokensSent: 5000,
        contextTokensReceived: 5000,
        truncated: false,
      };

      const spans = createDelegationSpans(delegation, "session-1", mockTracer, mockPiiRedactor, agentRegistry);
      
      expect(spans.delegatorSpan).toBeDefined();
      expect(spans.delegateeSpan).toBeDefined();
      expect(spans.contextSpan).toBeDefined();
      expect(mockTracer.startSpan).toHaveBeenCalledTimes(3);
    });

    it("should register delegatee agent", () => {
      const delegation = {
        fromAgentId: "agent-1",
        fromAgentName: "Planner",
        toAgentId: "agent-2",
        toAgentName: "Coder",
        rationale: "Test delegation",
        contextTokensSent: 5000,
        contextTokensReceived: 5000,
        truncated: false,
      };

      createDelegationSpans(delegation, "session-1", mockTracer, mockPiiRedactor, agentRegistry);
      
      const delegatee = agentRegistry.get("agent-2");
      expect(delegatee).toBeDefined();
      expect(delegatee.name).toBe("Coder");
      expect(delegatee.parentId).toBe("agent-1");
    });
  });

  describe("calculateContextFidelity", () => {
    it("should return 1.0 when no tokens sent", () => {
      const fidelity = calculateContextFidelity(0, 0, 100000);
      expect(fidelity).toBe(1.0);
    });

    it("should return 1.0 when no tokens dropped", () => {
      const fidelity = calculateContextFidelity(5000, 5000, 100000);
      expect(fidelity).toBe(1.0);
    });

    it("should calculate fidelity correctly", () => {
      const fidelity = calculateContextFidelity(10000, 8000, 100000);
      // dropped = 2000, available = min(10000, 100000) = 10000
      // fidelity = 1 - 2000/10000 = 0.8
      expect(fidelity).toBe(0.8);
    });

    it("should cap at maxContextTokens", () => {
      const fidelity = calculateContextFidelity(150000, 100000, 100000);
      // dropped = 50000, available = min(150000, 100000) = 100000
      // fidelity = 1 - 50000/100000 = 0.5
      expect(fidelity).toBe(0.5);
    });

    it("should not go below 0", () => {
      const fidelity = calculateContextFidelity(10000, 0, 100000);
      expect(fidelity).toBe(0);
    });
  });

  describe("addContextFidelityAttributes", () => {
    it("should add fidelity attributes to span", () => {
      const mockSpan = {
        setAttribute: vi.fn(),
      };

      addContextFidelityAttributes(mockSpan as any, 0.8, 10000, 8000, 100000);
      
      expect(mockSpan.setAttribute).toHaveBeenCalledWith('agent.context.fidelity', 0.8);
      expect(mockSpan.setAttribute).toHaveBeenCalledWith('agent.context.fidelity.percent', 80);
      expect(mockSpan.setAttribute).toHaveBeenCalledWith('agent.context.tokens_sent', 10000);
      expect(mockSpan.setAttribute).toHaveBeenCalledWith('agent.context.tokens_received', 8000);
      expect(mockSpan.setAttribute).toHaveBeenCalledWith('agent.context.tokens_dropped', 2000);
      expect(mockSpan.setAttribute).toHaveBeenCalledWith('agent.context.max_tokens', 100000);
    });

    it("should add alert when fidelity below threshold", () => {
      const mockSpan = {
        setAttribute: vi.fn(),
      };

      addContextFidelityAttributes(mockSpan as any, 0.5, 10000, 5000, 100000);
      
      expect(mockSpan.setAttribute).toHaveBeenCalledWith('agent.context.fidelity.alert', true);
      expect(mockSpan.setAttribute).toHaveBeenCalledWith('agent.context.fidelity.threshold', 0.7);
    });

    it("should not add alert when fidelity above threshold", () => {
      const mockSpan = {
        setAttribute: vi.fn(),
      };

      addContextFidelityAttributes(mockSpan as any, 0.9, 10000, 9000, 100000);
      
      expect(mockSpan.setAttribute).not.toHaveBeenCalledWith('agent.context.fidelity.alert', true);
    });
  });

  describe("trackHandoffChain", () => {
    it("should track handoff chain", () => {
      const convCtx = getOrCreateConversationContext("conv-test", "session-1", "agent-1", "Planner");
      
      const delegation = {
        fromAgentId: "agent-1",
        fromAgentName: "Planner",
        toAgentId: "agent-2",
        toAgentName: "Coder",
        rationale: "First delegation",
        contextTokensSent: 5000,
        contextTokensReceived: 5000,
        truncated: false,
      };

      const chain = trackHandoffChain(convCtx, delegation);
      
      expect(chain.length).toBe(1);
      expect(chain[0]).toBe(delegation);
    });

    it("should chain multiple delegations", () => {
      const convCtx = getOrCreateConversationContext("conv-test", "session-1", "agent-1", "Planner");
      
      const delegation1 = {
        fromAgentId: "agent-1",
        fromAgentName: "Planner",
        toAgentId: "agent-2",
        toAgentName: "Coder",
        rationale: "First",
        contextTokensSent: 5000,
        contextTokensReceived: 5000,
        truncated: false,
      };

      const delegation2 = {
        fromAgentId: "agent-2",
        fromAgentName: "Coder",
        toAgentId: "agent-3",
        toAgentName: "Tester",
        rationale: "Second",
        contextTokensSent: 3000,
        contextTokensReceived: 3000,
        truncated: false,
      };

      trackHandoffChain(convCtx, delegation1);
      const chain = trackHandoffChain(convCtx, delegation2);
      
      expect(chain.length).toBe(2);
    });
  });

  describe("getHandoffChain", () => {
    it("should return all delegations in conversation", () => {
      const convCtx = getOrCreateConversationContext("conv-test", "session-1", "agent-1", "Planner");
      
      const delegation1 = {
        fromAgentId: "agent-1",
        fromAgentName: "Planner",
        toAgentId: "agent-2",
        toAgentName: "Coder",
        rationale: "First",
        contextTokensSent: 5000,
        contextTokensReceived: 5000,
        truncated: false,
      };

      const delegation2 = {
        fromAgentId: "agent-2",
        fromAgentName: "Coder",
        toAgentId: "agent-3",
        toAgentName: "Tester",
        rationale: "Second",
        contextTokensSent: 3000,
        contextTokensReceived: 3000,
        truncated: false,
      };

      trackHandoffChain(convCtx, delegation1);
      trackHandoffChain(convCtx, delegation2);
      
      const chain = getHandoffChain(convCtx);
      expect(chain.length).toBe(2);
    });
  });
});