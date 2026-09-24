/**
 * opencode-otel-plugin - Logs Export
 *
 * OTLP log exporter for structured agent logs with event.name taxonomy.
 */

import type { RequiredConfig } from "../config.js";
import { createLogsExporter } from "./exporter.js";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION, ATTR_DEPLOYMENT_ENVIRONMENT_NAME } from "@opentelemetry/semantic-conventions";

// ─── Log Severity Mapping ─────────────────────────────────────────────────────

export const LogSeverity = {
  TRACE: 1,
  DEBUG: 5,
  INFO: 9,
  WARN: 13,
  ERROR: 17,
  FATAL: 21,
} as const;

// ─── Structured Log Event Taxonomy (event.name contract) ─────────────────────

export const LOG_EVENTS = {
  SESSION_CREATED: 'session.created',
  SESSION_IDLE: 'session.idle',
  SESSION_ERROR: 'session.error',
  USER_PROMPT: 'user_prompt',
  API_REQUEST: 'api_request',
  API_ERROR: 'api_error',
  TOOL_RESULT: 'tool_result',
  TOOL_DECISION: 'tool_decision',
  COMMIT: 'commit',
  // Extended for multi-agent coverage (still under event.name)
  LLM_CALL: 'api_request',
  LLM_ERROR: 'api_error',
} as const;

export type LogEventName = (typeof LOG_EVENTS)[keyof typeof LOG_EVENTS];

// ─── Logs Setup ───────────────────────────────────────────────────────────────

export interface LogsSetupResult {
  loggerProvider: any;
  logger: any;
  shutdown: () => Promise<void>;
  forceFlush: () => Promise<void>;
}

export async function createLogsSetup(config: RequiredConfig, sharedResource?: any): Promise<LogsSetupResult | null> {
  try {
    const { LoggerProvider } = await import("@opentelemetry/sdk-logs");
    const { BatchLogRecordProcessor } = await import("@opentelemetry/sdk-logs");

    const resource = sharedResource ?? resourceFromAttributes({
      [ATTR_SERVICE_NAME]: config.serviceName,
      [ATTR_SERVICE_VERSION]: config.serviceVersion,
      [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: config.environment,
    });

    const exporter = await createLogsExporter(config);

    const logProcessor = new BatchLogRecordProcessor({
      exporter,
      maxQueueSize: config.batch.maxQueueSize,
      maxExportBatchSize: config.batch.maxExportBatchSize,
      scheduledDelayMillis: config.batch.scheduledDelayMillis,
      exportTimeoutMillis: config.batch.exportTimeoutMillis,
    });

    const loggerProvider = new LoggerProvider({
      resource,
      processors: [logProcessor],
    });

    const logger = loggerProvider.getLogger('opencode-otel-plugin', config.serviceVersion);

    return {
      loggerProvider,
      logger,
      shutdown: async () => {
        await loggerProvider.shutdown();
      },
      forceFlush: async () => {
        await loggerProvider.forceFlush();
      },
    };
  } catch (error) {
    console.error('[otel] Failed to setup logs:', error);
    return null;
  }
}

// ─── Structured Log Helper ────────────────────────────────────────────────────

export interface AgentLogAttributes {
  sessionId?: string;
  conversationId?: string;
  agentId?: string;
  agentName?: string;
  operation?: string;
  durationMs?: number;
  error?: string;
  eventName?: string;
  [key: string]: string | number | boolean | undefined;
}

export class AgentLogger {
  private logger: any;
  private logsEnabled: boolean;
  private capturePromptInLogs: boolean;

  constructor(logger: any, options?: { logsEnabled?: boolean; capturePromptInLogs?: boolean }) {
    this.logger = logger;
    this.logsEnabled = options?.logsEnabled ?? true;
    this.capturePromptInLogs = options?.capturePromptInLogs ?? false;
  }

  emitEvent(eventName: string | undefined, message: string, severity: number, severityText: string, attributes: AgentLogAttributes = {}): void {
    if (!this.logsEnabled) return;
    let finalAttrs: AgentLogAttributes = { ...attributes };
    if (eventName) {
      finalAttrs['event.name'] = eventName;
    }
    if (!this.capturePromptInLogs) {
      for (const key of Object.keys(finalAttrs)) {
        if (key === 'prompt' || key === 'user_prompt' || key === 'content') {
          finalAttrs[key] = '[REDACTED]';
        }
      }
    }
    this.logger.emit({
      severityNumber: severity,
      severityText,
      body: message,
      attributes: this.cleanAttributes(finalAttrs),
    });
  }

  info(message: string, attributes: AgentLogAttributes = {}): void {
    this.emitEvent(attributes.eventName, message, LogSeverity.INFO, 'INFO', attributes);
  }

  debug(message: string, attributes: AgentLogAttributes = {}): void {
    this.emitEvent(attributes.eventName, message, LogSeverity.DEBUG, 'DEBUG', attributes);
  }

  warn(message: string, attributes: AgentLogAttributes = {}): void {
    this.emitEvent(attributes.eventName, message, LogSeverity.WARN, 'WARN', attributes);
  }

  error(message: string, attributes: AgentLogAttributes = {}): void {
    this.emitEvent(attributes.eventName, message, LogSeverity.ERROR, 'ERROR', attributes);
  }

  // Taxonomy convenience methods
  userPrompt(message: string, attributes: AgentLogAttributes = {}): void {
    this.emitEvent(LOG_EVENTS.USER_PROMPT, message, LogSeverity.INFO, 'INFO', attributes);
  }

  apiRequest(message: string, attributes: AgentLogAttributes = {}): void {
    this.emitEvent(LOG_EVENTS.API_REQUEST, message, LogSeverity.INFO, 'INFO', attributes);
  }

  apiError(message: string, attributes: AgentLogAttributes = {}): void {
    this.emitEvent(LOG_EVENTS.API_ERROR, message, LogSeverity.ERROR, 'ERROR', attributes);
  }

  toolResult(message: string, attributes: AgentLogAttributes = {}): void {
    this.emitEvent(LOG_EVENTS.TOOL_RESULT, message, LogSeverity.INFO, 'INFO', attributes);
  }

  toolDecision(message: string, attributes: AgentLogAttributes = {}): void {
    this.emitEvent(LOG_EVENTS.TOOL_DECISION, message, LogSeverity.INFO, 'INFO', attributes);
  }

  commit(message: string, attributes: AgentLogAttributes = {}): void {
    this.emitEvent(LOG_EVENTS.COMMIT, message, LogSeverity.INFO, 'INFO', attributes);
  }

  sessionCreated(message: string, attributes: AgentLogAttributes = {}): void {
    this.emitEvent(LOG_EVENTS.SESSION_CREATED, message, LogSeverity.INFO, 'INFO', attributes);
  }

  sessionIdle(message: string, attributes: AgentLogAttributes = {}): void {
    this.emitEvent(LOG_EVENTS.SESSION_IDLE, message, LogSeverity.INFO, 'INFO', attributes);
  }

  sessionError(message: string, attributes: AgentLogAttributes = {}): void {
    this.emitEvent(LOG_EVENTS.SESSION_ERROR, message, LogSeverity.ERROR, 'ERROR', attributes);
  }

  private cleanAttributes(attributes: AgentLogAttributes): Record<string, string | number | boolean> {
    const cleaned: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined && value !== null) {
        cleaned[key] = value;
      }
    }
    return cleaned;
  }
}
