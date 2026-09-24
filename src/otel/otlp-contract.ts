/**
 * opencode-otel-plugin - OTLP Payload Contract Tests
 * 
 * Validates OTLP payload structure against the OTLP/HTTP and OTLP/gRPC specifications.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OTLPResource {
  attributes: OTLPAttribute[];
  droppedAttributesCount?: number;
}

export interface OTLPAttribute {
  key: string;
  value: OTLPAnyValue;
}

export interface OTLPAnyValue {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values: OTLPAnyValue[] };
  kvlistValue?: { values: OTLPAttribute[] };
  bytesValue?: string;
}

export interface OTLPSpan {
  traceId: string;
  spanId: string;
  traceState?: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string | number;
  endTimeUnixNano: string | number;
  attributes: OTLPAttribute[];
  droppedAttributesCount?: number;
  events: OTLPEvent[];
  droppedEventsCount?: number;
  links: OTLPLink[];
  droppedLinksCount?: number;
  status: OTLPStatus;
}

export interface OTLPEvent {
  timeUnixNano: string | number;
  name: string;
  attributes: OTLPAttribute[];
  droppedAttributesCount?: number;
}

export interface OTLPLink {
  traceId: string;
  spanId: string;
  traceState?: string;
  attributes: OTLPAttribute[];
  droppedAttributesCount?: number;
}

export interface OTLPStatus {
  code: number;
  message?: string;
}

export interface OTLPExportTraceServiceRequest {
  resourceSpans: OTLPResourceSpan[];
}

export interface OTLPResourceSpan {
  resource: OTLPResource;
  scopeSpans: OTLPScopeSpan[];
  schemaUrl?: string;
}

export interface OTLPScopeSpan {
  scope: OTLPInstrumentationScope;
  spans: OTLPSpan[];
  schemaUrl?: string;
}

export interface OTLPInstrumentationScope {
  name: string;
  version?: string;
  attributes: OTLPAttribute[];
  droppedAttributesCount?: number;
}

// ─── Validation Results ───────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// ─── Validators ───────────────────────────────────────────────────────────────

export function validateOTLPTracePayload(payload: any): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  
  // Top-level structure
  if (!payload || typeof payload !== 'object') {
    errors.push('Payload must be an object');
    return { valid: false, errors, warnings };
  }
  
  if (!Array.isArray(payload.resourceSpans)) {
    errors.push('resourceSpans must be an array');
    return { valid: false, errors, warnings };
  }
  
  if (payload.resourceSpans.length === 0) {
    warnings.push('resourceSpans is empty');
  }
  
  // Validate each resource span
  payload.resourceSpans.forEach((resourceSpan: any, index: number) => {
    const prefix = `resourceSpans[${index}]`;
    
    if (!resourceSpan || typeof resourceSpan !== 'object') {
      errors.push(`${prefix} must be an object`);
      return;
    }
    
    // Validate resource
    if (!resourceSpan.resource) {
      errors.push(`${prefix}.resource is required`);
    } else {
      validateResource(resourceSpan.resource, `${prefix}.resource`, errors, warnings);
    }
    
    // Validate scope spans
    if (!Array.isArray(resourceSpan.scopeSpans)) {
      errors.push(`${prefix}.scopeSpans must be an array`);
      return;
    }
    
    resourceSpan.scopeSpans.forEach((scopeSpan: any, scopeIndex: number) => {
      const scopePrefix = `${prefix}.scopeSpans[${scopeIndex}]`;
      
      if (!scopeSpan || typeof scopeSpan !== 'object') {
        errors.push(`${scopePrefix} must be an object`);
        return;
      }
      
      // Validate scope
      if (!scopeSpan.scope) {
        errors.push(`${scopePrefix}.scope is required`);
      } else {
        validateScope(scopeSpan.scope, `${scopePrefix}.scope`, errors);
      }
      
      // Validate spans
      if (!Array.isArray(scopeSpan.spans)) {
        errors.push(`${scopePrefix}.spans must be an array`);
        return;
      }
      
      if (scopeSpan.spans.length === 0) {
        warnings.push(`${scopePrefix}.spans is empty`);
      }
      
      scopeSpan.spans.forEach((span: any, spanIndex: number) => {
        validateSpan(span, `${scopePrefix}.spans[${spanIndex}]`, errors, warnings);
      });
    });
  });
  
  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

function validateResource(resource: any, path: string, errors: string[], warnings: string[]): void {
  if (!Array.isArray(resource.attributes)) {
    errors.push(`${path}.attributes must be an array`);
    return;
  }
  
  // Check for required service.name attribute
  const hasServiceName = resource.attributes.some(
    (attr: any) => attr.key === 'service.name' || attr.key === 'service.name'
  );
  
  if (!hasServiceName) {
    warnings.push(`${path} missing recommended service.name attribute`);
  }
  
  // Validate each attribute
  resource.attributes.forEach((attr: any, index: number) => {
    validateAttribute(attr, `${path}.attributes[${index}]`, errors);
  });
}

function validateScope(scope: any, path: string, errors: string[]): void {
  if (!scope.name || typeof scope.name !== 'string') {
    errors.push(`${path}.name is required and must be a string`);
  }
  
  if (scope.attributes && !Array.isArray(scope.attributes)) {
    errors.push(`${path}.attributes must be an array`);
  }
}

function validateSpan(span: any, path: string, errors: string[], warnings: string[]): void {
  if (!span || typeof span !== 'object') {
    errors.push(`${path} must be an object`);
    return;
  }
  
  // Required fields
  if (!span.traceId || typeof span.traceId !== 'string') {
    errors.push(`${path}.traceId is required and must be a string`);
  } else if (span.traceId.length !== 32) {
    errors.push(`${path}.traceId must be 32 hex characters, got ${span.traceId.length}`);
  }
  
  if (!span.spanId || typeof span.spanId !== 'string') {
    errors.push(`${path}.spanId is required and must be a string`);
  } else if (span.spanId.length !== 16) {
    errors.push(`${path}.spanId must be 16 hex characters, got ${span.spanId.length}`);
  }
  
  if (!span.name || typeof span.name !== 'string') {
    errors.push(`${path}.name is required and must be a string`);
  }
  
  if (span.kind === undefined || typeof span.kind !== 'number') {
    errors.push(`${path}.kind is required and must be a number`);
  } else if (span.kind < 0 || span.kind > 4) {
    errors.push(`${path}.kind must be between 0 and 4, got ${span.kind}`);
  }
  
  if (span.startTimeUnixNano === undefined) {
    errors.push(`${path}.startTimeUnixNano is required`);
  }
  
  if (span.endTimeUnixNano === undefined) {
    errors.push(`${path}.endTimeUnixNano is required`);
  }
  
  // Validate attributes
  if (span.attributes) {
    if (!Array.isArray(span.attributes)) {
      errors.push(`${path}.attributes must be an array`);
    } else {
      span.attributes.forEach((attr: any, index: number) => {
        validateAttribute(attr, `${path}.attributes[${index}]`, errors);
      });
    }
  }
  
  // Validate events
  if (span.events) {
    if (!Array.isArray(span.events)) {
      errors.push(`${path}.events must be an array`);
    } else {
      span.events.forEach((event: any, index: number) => {
        validateEvent(event, `${path}.events[${index}]`, errors);
      });
    }
  }
  
  // Validate status
  if (span.status) {
    validateStatus(span.status, `${path}.status`, errors);
  }
  
  // Check for GenAI attributes (recommended)
  if (Array.isArray(span.attributes)) {
    const hasGenAI = span.attributes.some((attr: any) => 
      attr.key && attr.key.startsWith('gen_ai.')
    );
    if (!hasGenAI) {
      warnings.push(`${path} missing gen_ai.* attributes (recommended for GenAI spans)`);
    }
  }
}

function validateAttribute(attr: any, path: string, errors: string[]): void {
  if (!attr || typeof attr !== 'object') {
    errors.push(`${path} must be an object`);
    return;
  }
  
  if (!attr.key || typeof attr.key !== 'string') {
    errors.push(`${path}.key is required and must be a string`);
    return;
  }
  
  if (!attr.value || typeof attr.value !== 'object') {
    errors.push(`${path}.value is required and must be an object`);
    return;
  }
  
  // Validate AnyValue has exactly one type field
  const valueKeys = Object.keys(attr.value).filter(k => 
    ['stringValue', 'intValue', 'doubleValue', 'boolValue', 'arrayValue', 'kvlistValue', 'bytesValue'].includes(k)
  );
  
  if (valueKeys.length === 0) {
    errors.push(`${path}.value must have one of: stringValue, intValue, doubleValue, boolValue, arrayValue, kvlistValue, bytesValue`);
  }
}

function validateEvent(event: any, path: string, errors: string[]): void {
  if (!event || typeof event !== 'object') {
    errors.push(`${path} must be an object`);
    return;
  }
  
  if (!event.name || typeof event.name !== 'string') {
    errors.push(`${path}.name is required and must be a string`);
  }
  
  if (event.timeUnixNano === undefined) {
    errors.push(`${path}.timeUnixNano is required`);
  }
  
  if (event.attributes && !Array.isArray(event.attributes)) {
    errors.push(`${path}.attributes must be an array`);
  }
}

function validateStatus(status: any, path: string, errors: string[]): void {
  if (typeof status.code !== 'number') {
    errors.push(`${path}.code is required and must be a number`);
  }
  
  if (status.code < 0 || status.code > 2) {
    errors.push(`${path}.code must be 0 (UNSET), 1 (OK), or 2 (ERROR), got ${status.code}`);
  }
}

// ─── GenAI Semantic Conventions Validation ────────────────────────────────────

export function validateGenAIAttributes(attributes: OTLPAttribute[]): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  
  const attrMap = new Map(attributes.map(a => [a.key, a]));
  
  // Required GenAI attributes for spans
  const requiredAttrs = [
    'gen_ai.operation.name',
    'gen_ai.provider.name',
  ];
  
  for (const key of requiredAttrs) {
    if (!attrMap.has(key)) {
      errors.push(`Missing required GenAI attribute: ${key}`);
    }
  }
  
  // Recommended attributes
  const recommendedAttrs = [
    'gen_ai.request.model',
    'gen_ai.response.model',
    'gen_ai.system',
    'gen_ai.token_usage.input',
    'gen_ai.token_usage.output',
  ];
  
  for (const key of recommendedAttrs) {
    if (!attrMap.has(key)) {
      warnings.push(`Missing recommended GenAI attribute: ${key}`);
    }
  }
  
  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ─── Multi-Agent Extension Validation ─────────────────────────────────────────

export function validateMultiAgentAttributes(attributes: OTLPAttribute[]): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  
  const attrMap = new Map(attributes.map(a => [a.key, a]));
  
  // Check for conversation ID (required for multi-agent)
  if (!attrMap.has('gen_ai.conversation.id')) {
    warnings.push('Missing gen_ai.conversation.id (recommended for multi-agent tracing)');
  }
  
  // Check for agent ID
  if (!attrMap.has('gen_ai.agent.id')) {
    warnings.push('Missing gen_ai.agent.id (recommended for multi-agent tracing)');
  }
  
  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

// ─── Hex Validation Helpers ───────────────────────────────────────────────────

export function isValidTraceId(traceId: string): boolean {
  return /^[0-9a-f]{32}$/i.test(traceId) && traceId !== '0'.repeat(32);
}

export function isValidSpanId(spanId: string): boolean {
  return /^[0-9a-f]{16}$/i.test(spanId) && spanId !== '0'.repeat(16);
}

export function isValidTraceFlags(flags: number): boolean {
  return Number.isInteger(flags) && flags >= 0 && flags <= 255;
}
