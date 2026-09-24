/**
 * opencode-otel-plugin - Logs Module Tests
 *
 * Tests AgentLogger and LogSeverity (RESEARCH.md gap #3).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AgentLogger, LogSeverity } from "../../dist/otel/logs.js";

function createMockLogger() {
  return { emit: vi.fn() };
}

describe("Logs Module", () => {
  describe("LogSeverity", () => {
    it("should match OTLP severity numbers", () => {
      expect(LogSeverity.TRACE).toBe(1);
      expect(LogSeverity.DEBUG).toBe(5);
      expect(LogSeverity.INFO).toBe(9);
      expect(LogSeverity.WARN).toBe(13);
      expect(LogSeverity.ERROR).toBe(17);
      expect(LogSeverity.FATAL).toBe(21);
    });
  });

  describe("AgentLogger", () => {
    let mockLogger: ReturnType<typeof createMockLogger>;
    let logger: AgentLogger;

    beforeEach(() => {
      mockLogger = createMockLogger();
      logger = new AgentLogger(mockLogger);
    });

    it("info should emit with INFO severity", () => {
      logger.info("session started", { sessionId: "s1" });
      expect(mockLogger.emit).toHaveBeenCalledWith({
        severityNumber: LogSeverity.INFO,
        severityText: "INFO",
        body: "session started",
        attributes: { sessionId: "s1" },
      });
    });

    it("debug should emit with DEBUG severity", () => {
      logger.debug("span ended");
      expect(mockLogger.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          severityNumber: LogSeverity.DEBUG,
          severityText: "DEBUG",
          body: "span ended",
        })
      );
    });

    it("warn should emit with WARN severity", () => {
      logger.warn("slow operation", { durationMs: 5000 });
      expect(mockLogger.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          severityNumber: LogSeverity.WARN,
          severityText: "WARN",
        })
      );
    });

    it("error should emit with ERROR severity", () => {
      logger.error("export failed", { error: "timeout" });
      expect(mockLogger.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          severityNumber: LogSeverity.ERROR,
          severityText: "ERROR",
          body: "export failed",
          attributes: { error: "timeout" },
        })
      );
    });

    it("should strip undefined and null attributes", () => {
      logger.info("msg", {
        sessionId: "s1",
        agentName: undefined,
        durationMs: undefined,
        error: undefined,
      });
      expect(mockLogger.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          attributes: { sessionId: "s1" },
        })
      );
    });

    it("should keep zero and false attribute values", () => {
      logger.info("msg", { durationMs: 0, success: false });
      expect(mockLogger.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          attributes: { durationMs: 0, success: false },
        })
      );
    });

    it("should emit with empty attributes by default", () => {
      logger.info("bare message");
      expect(mockLogger.emit).toHaveBeenCalledWith(
        expect.objectContaining({ attributes: {} })
      );
    });

    // ─── event.name taxonomy ───────────────────────────────────────────────

    it("should emit event.name on taxonomy methods", () => {
      logger.userPrompt("hello", { sessionId: "s1" });
      expect(mockLogger.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          body: "hello",
          attributes: expect.objectContaining({
            sessionId: "s1",
            "event.name": "user_prompt",
          }),
        })
      );

      logger.apiRequest("llm call", { model: "gpt-4" });
      expect(mockLogger.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          attributes: expect.objectContaining({ "event.name": "api_request" }),
        })
      );

      logger.apiError("boom", { error: "500" });
      expect(mockLogger.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          severityNumber: LogSeverity.ERROR,
          attributes: expect.objectContaining({ "event.name": "api_error" }),
        })
      );

      logger.toolResult("done");
      expect(mockLogger.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          attributes: expect.objectContaining({ "event.name": "tool_result" }),
        })
      );

      logger.toolDecision("allow", { decision: "allow" });
      expect(mockLogger.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          attributes: expect.objectContaining({ "event.name": "tool_decision" }),
        })
      );

      logger.commit("git commit");
      expect(mockLogger.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          attributes: expect.objectContaining({ "event.name": "commit" }),
        })
      );

      logger.sessionCreated("up");
      expect(mockLogger.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          attributes: expect.objectContaining({ "event.name": "session.created" }),
        })
      );

      logger.sessionIdle("idle");
      expect(mockLogger.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          attributes: expect.objectContaining({ "event.name": "session.idle" }),
        })
      );

      logger.sessionError("err");
      expect(mockLogger.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          severityNumber: LogSeverity.ERROR,
          attributes: expect.objectContaining({ "event.name": "session.error" }),
        })
      );
    });

    it("should not inject event.name on generic info() without eventName", () => {
      logger.info("plain", { sessionId: "s1" });
      expect(mockLogger.emit).toHaveBeenCalledWith({
        severityNumber: LogSeverity.INFO,
        severityText: "INFO",
        body: "plain",
        attributes: { sessionId: "s1" },
      });
    });

    it("should redact prompt fields unless capturePromptInLogs", () => {
      logger.userPrompt("raw prompt", { prompt: "secret" });
      expect(mockLogger.emit).toHaveBeenCalledWith(
        expect.objectContaining({
          attributes: expect.objectContaining({ prompt: "[REDACTED]" }),
        })
      );

      const captureLogger = new AgentLogger(mockLogger, { capturePromptInLogs: true });
      captureLogger.userPrompt("raw prompt", { prompt: "visible" });
      expect(mockLogger.emit).toHaveBeenLastCalledWith(
        expect.objectContaining({
          attributes: expect.objectContaining({ prompt: "visible" }),
        })
      );
    });

    it("should no-op when logsEnabled=false", () => {
      const off = new AgentLogger(mockLogger, { logsEnabled: false });
      off.info("nope");
      off.userPrompt("nope");
      expect(mockLogger.emit).not.toHaveBeenCalled();
    });
  });
});
