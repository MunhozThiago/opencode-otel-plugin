/**
 * opencode-otel-plugin - PII Redaction
 * 
 * Redacts sensitive information from span attributes before export.
 */

import type { Attributes, RedactionRule, PIIConfig } from "../types.js";

// ─── Default Redaction Patterns ────────────────────────────────────────────────

const DEFAULT_PATTERNS: RedactionRule[] = [
  // API Keys (various formats)
  { pattern: /\b(?:api[_-]?key|apikey)['"]?\s*[:=]\s*['"]?([a-zA-Z0-9_\-]{20,})['"]?/gi, replacement: '[REDACTED_API_KEY]' },
  { pattern: /\b(?:api[_-]?key|apikey)['"]?\s*[:=]\s*['"]([^'"]{20,})['"]/gi, replacement: '[REDACTED_API_KEY]' },
  
  // Bearer tokens (Authorization: Bearer <token>)
  { pattern: /\b(?:authorization:\s*)?(?:bearer|token)\s+([a-zA-Z0-9_\-\.]{20,})/gi, replacement: '[REDACTED_TOKEN]' },
  { pattern: /\b(?:bearer|token)['"]?\s*[:=]\s*['"]?([a-zA-Z0-9_\-\.]{20,})['"]?/gi, replacement: '[REDACTED_TOKEN]' },
  
  // AWS keys
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: '[REDACTED_AWS_KEY]' },
  { pattern: /\b(?:aws[_-]?secret[_-]?access[_-]?key)['"]?\s*[:=]\s*['"]?([a-zA-Z0-9/+=]{40})['"]?/gi, replacement: '[REDACTED_AWS_SECRET]' },
  
  // GitHub tokens
  { pattern: /\bgh[ps]_[a-zA-Z0-9]{36,}\b/g, replacement: '[REDACTED_GITHUB_TOKEN]' },
  { pattern: /\bgithub[_-]?token['"]?\s*[:=]\s*['"]?([a-zA-Z0-9_]{36,})['"]?/gi, replacement: '[REDACTED_GITHUB_TOKEN]' },
  
  // Generic secrets
  { pattern: /\b(?:secret|password|passwd|pwd)['"]?\s*[:=]\s*['"]([^'"]{8,})['"]/gi, replacement: '[REDACTED_SECRET]' },
  
  // JWT tokens
  { pattern: /\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g, replacement: '[REDACTED_JWT]' },
  
  // Private keys
  { pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, replacement: '[REDACTED_PRIVATE_KEY]' },
  
  // Database URLs with credentials - replace the credentials part
  { pattern: /\b(?:mongodb|postgres|mysql|redis):\/\/[^:]+:[^@]+@/g, replacement: (match) => match.replace(/:[^:@]+@/, ':[REDACTED]@') },
  
  // Credit card numbers (basic)
  { pattern: /\b(?:\d[ -]*?){13,16}\b/g, replacement: '[REDACTED_CC]' },
  
  // Email addresses (optional - can be enabled)
  // { pattern: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g, replacement: '[REDACTED_EMAIL]' },
  
  // Phone numbers (basic)
  { pattern: /\b(?:\+?1[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}\b/g, replacement: '[REDACTED_PHONE]' },
  
  // Social Security Numbers (US)
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: '[REDACTED_SSN]' },
];

// ─── Field-Based Redaction ────────────────────────────────────────────────────

const SENSITIVE_FIELDS = new Set([
  'apiKey', 'api_key', 'apikey',
  'password', 'passwd', 'pwd',
  'secret', 'secretKey', 'secret_key',
  'token', 'accessToken', 'access_token', 'refreshToken', 'refresh_token',
  'authorization', 'auth',
  'apiSecret', 'api_secret',
  'privateKey', 'private_key',
  'clientSecret', 'client_secret',
  'webhookSecret', 'webhook_secret',
  'signingKey', 'signing_key',
  'encryptionKey', 'encryption_key',
  'sshKey', 'ssh_key',
  'gpgKey', 'gpg_key',
]);

// ─── Redaction Engine ─────────────────────────────────────────────────────────

export class PIIRedactor {
  private config: PIIConfig;
  private compiledPatterns: RedactionRule[];

  constructor(config: PIIConfig) {
    this.config = config;
    this.compiledPatterns = [...DEFAULT_PATTERNS, ...(config.patterns || [])];
  }

  /**
   * Redact PII from a string value
   */
  redactString(value: string): string {
    if (!this.config.enabled) return value;
    
    let result = value;
    for (const rule of this.compiledPatterns) {
      const replacement = rule.replacement;
      if (typeof replacement === 'function') {
        result = result.replace(rule.pattern, replacement as (substring: string, ...args: any[]) => string);
      } else {
        result = result.replace(rule.pattern, replacement);
      }
    }
    return result;
  }

  /**
   * Redact PII from an attribute value (string, number, boolean, object, array)
   */
  redactValue(value: unknown, fieldName?: string): unknown {
    if (!this.config.enabled) return value;
    
    // Check if field name is sensitive
    if (fieldName && this.isSensitiveField(fieldName)) {
      return '[REDACTED]';
    }
    
    if (typeof value === 'string') {
      return this.redactString(value);
    }
    
    if (Array.isArray(value)) {
      return value.map(v => this.redactValue(v));
    }
    
    if (value && typeof value === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value)) {
        result[key] = this.redactValue(val, key);
      }
      return result;
    }
    
    // Numbers, booleans, null, undefined - return as-is
    return value;
  }

  /**
   * Redact all values in an Attributes object
   */
  redactAttributes(attributes: Attributes): Attributes {
    if (!this.config.enabled) return attributes;
    
    const result: Attributes = {};
    for (const [key, value] of Object.entries(attributes)) {
      result[key] = this.redactValue(value, key) as string | number | boolean | string[] | number[] | boolean[] | undefined;
    }
    return result;
  }

  /**
   * Check if a field name is considered sensitive
   */
  private isSensitiveField(fieldName: string): boolean {
    const lower = fieldName.toLowerCase();
    
    // Check exact matches
    if (this.config.defaultFields.some(f => f.toLowerCase() === lower)) {
      return true;
    }
    
    // Check common sensitive field patterns
    for (const sensitive of SENSITIVE_FIELDS) {
      if (lower.includes(sensitive.toLowerCase())) {
        return true;
      }
    }
    
    // Check custom fields
    for (const custom of this.config.defaultFields) {
      if (lower.includes(custom.toLowerCase())) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<PIIConfig>): void {
    this.config = { ...this.config, ...config };
    this.compiledPatterns = [...DEFAULT_PATTERNS, ...(this.config.patterns || [])];
  }
}

// ─── Factory Function ─────────────────────────────────────────────────────────

export function createPIIRedactor(config: PIIConfig): PIIRedactor {
  return new PIIRedactor(config);
}

// ─── Helper: Hash Memory Keys ─────────────────────────────────────────────────

export function hashMemoryKey(key: string): string {
  // Simple hash for memory keys - in production use crypto.subtle
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    const char = key.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return `mem_${Math.abs(hash).toString(16).padStart(8, '0')}`;
}

// ─── Export ───────────────────────────────────────────────────────────────────

export { DEFAULT_PATTERNS, SENSITIVE_FIELDS };
export type { RedactionRule, PIIConfig };