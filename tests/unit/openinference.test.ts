/**
 * opencode-otel-plugin - OpenInference dual attribute tests
 */

import { describe, it, expect } from "vitest";
import {
  addOpenInferenceAttributes,
  openInferenceSpanKind,
  OPENINFERENCE,
  addChatAttributes,
  addToolAttributes,
  createBaseAttributes,
} from "../../dist/otel/semantic-conventions.js";

describe("OpenInference dual attributes", () => {
  describe("openInferenceSpanKind", () => {
    it("maps operations to OpenInference span kinds", () => {
      expect(openInferenceSpanKind("chat")).toBe("LLM");
      expect(openInferenceSpanKind("execute_tool")).toBe("TOOL");
      expect(openInferenceSpanKind("invoke_agent")).toBe("AGENT");
      expect(openInferenceSpanKind("invoke_workflow")).toBe("AGENT");
      expect(openInferenceSpanKind("search_memory")).toBe("RETRIEVER");
      expect(openInferenceSpanKind("plan")).toBe("CHAIN");
      expect(openInferenceSpanKind("mystery")).toBe("UNKNOWN");
    });
  });

  describe("addOpenInferenceAttributes", () => {
    it("adds model/provider/token attributes from GenAI keys", () => {
      const attrs = addChatAttributes({} as any, {
        requestModel: "gpt-4",
        providerName: "openai",
        system: "openai",
        inputTokens: 100,
        outputTokens: 50,
      });
      addOpenInferenceAttributes(attrs, { operationName: "chat" });
      expect((attrs as any)[OPENINFERENCE.OPERATION_NAME]).toBe("LLM");
      expect((attrs as any)[OPENINFERENCE.MODEL_NAME]).toBe("gpt-4");
      expect((attrs as any)[OPENINFERENCE.PROVIDER]).toBe("openai");
      expect((attrs as any)[OPENINFERENCE.INPUT_TOKENS]).toBe(100);
      expect((attrs as any)[OPENINFERENCE.OUTPUT_TOKENS]).toBe(50);
      expect((attrs as any)[OPENINFERENCE.TOTAL_TOKENS]).toBe(150);
    });

    it("adds tool name/call_id/parameters", () => {
      const attrs = addToolAttributes({} as any, {
        toolName: "bash",
        toolCallId: "call_1",
        input: { command: "ls" },
        output: "file1\nfile2",
        durationMs: 12,
      });
      expect((attrs as any)[OPENINFERENCE.TOOL_NAME]).toBe("bash");
      expect((attrs as any)[OPENINFERENCE.TOOL_CALL_ID]).toBe("call_1");
      expect((attrs as any)[OPENINFERENCE.TOOL_PARAMETERS]).toContain("ls");
      expect((attrs as any)[OPENINFERENCE.OPERATION_NAME]).toBe("TOOL");
      expect((attrs as any)[`${OPENINFERENCE.OUTPUT_MESSAGES}.0.message.content`]).toContain("file1");
    });

    it("respects explicit overrides over GenAI keys", () => {
      const attrs = {} as any;
      addOpenInferenceAttributes(attrs, {
        operationName: "chat",
        modelName: "claude-3",
        providerName: "anthropic",
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      });
      expect(attrs[OPENINFERENCE.MODEL_NAME]).toBe("claude-3");
      expect(attrs[OPENINFERENCE.PROVIDER]).toBe("anthropic");
      expect(attrs[OPENINFERENCE.TOTAL_TOKENS]).toBe(15);
    });

    it("no-ops safely on empty attrs with no data", () => {
      const attrs = {} as any;
      addOpenInferenceAttributes(attrs);
      expect(Object.keys(attrs)).toHaveLength(0);
    });
  });

  describe("createBaseAttributes projectId", () => {
    it("sets project.id and session.project_id when provided", () => {
      const base = createBaseAttributes("s1", "a1", "primary", "c1", "agent.root", {
        projectId: "proj-9",
      });
      expect((base as any)["project.id"]).toBe("proj-9");
      expect((base as any)["session.project_id"]).toBe("proj-9");
    });

    it("omits project.id when not provided", () => {
      const base = createBaseAttributes("s1", "a1", "primary", "c1", "agent.root");
      expect((base as any)["project.id"]).toBeUndefined();
    });
  });
});
