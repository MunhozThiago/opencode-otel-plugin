/**
 * opencode-otel-plugin - Event Validation
 * 
 * Centralized validation and error handling utilities for event mappers.
 * Ensures graceful degradation when opencode emits malformed or incomplete events.
 */

import type { Span } from "@opentelemetry/api";

/**
 * Generic validation result type
 */
export interface ValidationResult<T = unknown> {
  valid: boolean;
  value?: T;
  errors: string[];
}

/**
 * Validates that a value is a non-empty string
 */
export function isNonEmptyString(value: unknown, field: string): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validates that a value is a finite number
 */
export function isFiniteNumber(value: unknown, field: string): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Validates that a value is a positive integer
 */
export function isPositiveInteger(value: unknown, field: string): value is number {
  return isFiniteNumber(value, field) && value >= 0 && Number.isInteger(value);
}

/**
 * Validates that a value is a string array
 */
export function isStringArray(value: unknown, field: string): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Validates that a value is a record
 */
export function isRecord(value: unknown, field: string): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates that a value is one of the allowed values
 */
export function isOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string
): value is T {
  return typeof value === "string" && allowed.includes(value as T);
}

/**
 * Validates the common event shape
 */
export function validateEventShape(event: unknown, eventType: string): ValidationResult {
  const errors: string[] = [];
  
  if (!isRecord(event, "event")) {
    errors.push("event must be an object");
    return { valid: false, errors };
  }
  
  if (!isNonEmptyString(event.type, "event.type")) {
    errors.push("event.type must be a non-empty string");
  } else if (event.type !== eventType) {
    // Support pipe-separated event type lists
    const allowed = eventType.split("|");
    if (!allowed.includes(event.type)) {
      errors.push(`event.type must be one of: ${eventType}`);
    }
  }
  
  if (!isRecord(event.properties, "event.properties")) {
    errors.push("event.properties must be an object");
    return { valid: false, errors };
  }
  
  if (!isRecord(event.properties.info, "event.properties.info")) {
    errors.push("event.properties.info must be an object");
    return { valid: false, errors };
  }
  
  return { valid: errors.length === 0, errors };
}

/**
 * Validates session ID
 */
export function validateSessionId(sessionID: unknown): ValidationResult<string> {
  if (!isNonEmptyString(sessionID, "sessionID")) {
    return {
      valid: false,
      errors: ["sessionID must be a non-empty string"],
    };
  }
  return { valid: true, value: sessionID, errors: [] };
}

/**
 * Validates ID
 */
export function validateId(id: unknown, field: string, errors?: string[]): ValidationResult<string> {
  if (!isNonEmptyString(id, field)) {
    const message = `${field} must be a non-empty string`;
    if (errors) errors.push(message);
    return {
      valid: false,
      errors: [message],
    };
  }
  return { valid: true, value: id, errors: [] };
}

/**
 * Validates optional string
 */
export function validateOptionalString(
  value: unknown,
  field: string,
  errors: string[]
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isNonEmptyString(value, field)) {
    errors.push(`${field} must be a non-empty string`);
    return undefined;
  }
  return value;
}

/**
 * Validates optional number
 */
export function validateOptionalNumber(
  value: unknown,
  field: string,
  errors: string[]
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isFiniteNumber(value, field)) {
    errors.push(`${field} must be a finite number`);
    return undefined;
  }
  return value;
}

/**
 * Validates optional integer
 */
export function validateOptionalInteger(
  value: unknown,
  field: string,
  errors: string[]
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isPositiveInteger(value, field)) {
    errors.push(`${field} must be a non-negative integer`);
    return undefined;
  }
  return value;
}

/**
 * Validates optional string array
 */
export function validateOptionalStringArray(
  value: unknown,
  field: string,
  errors: string[]
): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isStringArray(value, field)) {
    errors.push(`${field} must be an array of strings`);
    return undefined;
  }
  return value;
}

/**
 * Validates optional record
 */
export function validateOptionalRecord(
  value: unknown,
  field: string,
  errors: string[]
): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value, field)) {
    errors.push(`${field} must be an object`);
    return undefined;
  }
  return value;
}

/**
 * Validates optional array
 */
export function validateOptionalArray(
  value: unknown,
  field: string,
  errors: string[]
): unknown[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array`);
    return undefined;
  }
  return value;
}

/**
 * Validates optional boolean
 */
export function validateOptionalBoolean(
  value: unknown,
  field: string,
  errors: string[]
): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    errors.push(`${field} must be a boolean`);
    return undefined;
  }
  return value;
}

/**
 * Validates a value against allowed values
 */
export function validateOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  errors: string[]
): T | undefined {
  if (!isOneOf(value, allowed, field)) {
    errors.push(`${field} must be one of: ${allowed.join(", ")}`);
    return undefined;
  }
  return value as T;
}

/**
 * Safely stringifies a value with truncation
 */
export function safeStringify(value: unknown, maxLength = 10000): string {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return "undefined";
    return serialized.length > maxLength
      ? serialized.substring(0, maxLength) + "...[truncated]"
      : serialized;
  } catch {
    return "[unserializable]";
  }
}

/**
 * Safely gets a span from activeSpans
 */
export function getActiveSpan(
  activeSpans: Map<string, Span>,
  key: string
): Span | undefined {
  try {
    return activeSpans.get(key);
  } catch {
    return undefined;
  }
}

/**
 * Safely sets a span in activeSpans
 */
export function setActiveSpan(
  activeSpans: Map<string, Span>,
  key: string,
  span: Span
): void {
  try {
    activeSpans.set(key, span);
  } catch {
    // Gracefully degrade if span storage fails
  }
}

/**
 * Safely deletes a span from activeSpans
 */
export function deleteActiveSpan(
  activeSpans: Map<string, Span>,
  key: string
): void {
  try {
    activeSpans.delete(key);
  } catch {
    // Gracefully degrade if span storage fails
  }
}

/**
 * Safely adds an event to a span
 */
export function addSpanEvent(
  span: Span | undefined,
  name: string,
  attributes?: Record<string, unknown>
): void {
  if (!span) return;
  try {
    span.addEvent(name, attributes);
  } catch {
    // Gracefully degrade if span event fails
  }
}

/**
 * Safely ends a span
 */
export function endSpan(span: Span | undefined): void {
  if (!span) return;
  try {
    span.end();
  } catch {
    // Gracefully degrade if span end fails
  }
}

/**
 * Safely sets a span attribute
 */
export function setSpanAttribute(
  span: Span | undefined,
  key: string,
  value: unknown
): void {
  if (!span) return;
  try {
    span.setAttribute(key, value as never);
  } catch {
    // Gracefully degrade if span attribute fails
  }
}

/**
 * Truncates a string to a maximum length
 */
export function truncateString(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return value.substring(0, maxLength) + "...[truncated]";
}
