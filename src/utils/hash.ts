/**
 * opencode-otel-plugin - Hash Utilities
 * 
 * Hashing functions for memory keys, strings, and context packages.
 */

// ─── Hash Functions ────────────────────────────────────────────────────────────

/**
 * Hash a memory key for PII-safe storage
 */
export function hashMemoryKey(key: string): string {
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    const char = key.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return `mem_${Math.abs(hash).toString(16).padStart(8, '0')}`;
}

/**
 * Hash a string for comparison (e.g., context package diff)
 */
export function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
}

/**
 * Generate a stable agent ID from agent name and session
 */
export function generateAgentId(agentName: string, sessionId: string): string {
  const str = `${agentName}:${sessionId}`;
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  return `agent_${Math.abs(hash).toString(16).padStart(12, '0')}`;
}

/**
 * Generate a stable conversation ID from session
 */
export function generateConversationId(sessionId: string): string {
  return `conv_${sessionId}`;
}

/**
 * Generate a unique span ID (16 hex chars)
 */
export function generateSpanId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Generate a unique trace ID (32 hex chars)
 */
export function generateTraceId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
