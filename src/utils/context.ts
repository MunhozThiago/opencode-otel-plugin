/**
 * opencode-otel-plugin - Context Window Utilities
 * 
 * Context window snapshots, token estimation, and context package utilities.
 */

import type { ContextPackage } from "../types.js";

// ─── Token Estimation ─────────────────────────────────────────────────────────

/**
 * Estimate token count for a string (rough approximation)
 */
export function estimateTokens(text: string): number {
  // Rough approximation: ~4 characters per token for English
  return Math.ceil(text.length / 4);
}

// ─── Context Package ──────────────────────────────────────────────────────────

/**
 * Create a context package snapshot from messages
 */
export function createContextPackage(
  messages: Array<{ role: string; content: string }>,
  maxTokens: number = 200000
): ContextPackage {
  let totalTokens = 0;
  const packagedMessages: Array<{ role: string; content: string; tokens: number }> = [];
  let truncated = false;

  // Process messages in reverse (most recent first) to fit in context window
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const tokens = estimateTokens(msg.content);
    
    if (totalTokens + tokens > maxTokens && packagedMessages.length > 0) {
      truncated = true;
      break;
    }
    
    packagedMessages.unshift({
      role: msg.role,
      content: msg.content,
      tokens,
    });
    totalTokens += tokens;
  }

  return {
    tokensSent: totalTokens,
    tokensReceived: totalTokens, // Will be updated by receiver
    truncated,
    messages: packagedMessages,
  };
}

// ─── Context Window Fill Calculation ──────────────────────────────────────────

/**
 * Calculate context window fill percentage
 */
export function calculateContextFill(
  usedTokens: number,
  maxTokens: number
): { fillPercent: number; tokensAvailable: number; tokensUsed: number } {
  const fillPercent = maxTokens > 0 ? (usedTokens / maxTokens) * 100 : 0;
  return {
    fillPercent: Math.min(100, Math.max(0, fillPercent)),
    tokensAvailable: Math.max(0, maxTokens - usedTokens),
    tokensUsed: usedTokens,
  };
}

/**
 * Calculate context fidelity score
 */
export function calculateContextFidelity(
  tokensSent: number,
  tokensReceived: number,
  maxTokens?: number
): { fidelity: number; fidelityPercent: number; tokensDropped: number } {
  const tokensDropped = Math.max(0, tokensSent - tokensReceived);
  const fidelity = tokensSent > 0 ? tokensReceived / tokensSent : 1;
  return {
    fidelity: Math.min(1, Math.max(0, fidelity)),
    fidelityPercent: Math.round(fidelity * 100),
    tokensDropped,
  };
}

// ─── Context Package Diff ─────────────────────────────────────────────────────

/**
 * Diff two context packages
 */
export function diffContextPackages(
  sent: ContextPackage,
  received: ContextPackage
): string {
  const sentHashes = new Set(sent.messages.map(m => hashContent(`${m.role}:${m.content}`)));
  const receivedHashes = new Set(received.messages.map(m => hashContent(`${m.role}:${m.content}`)));
  
  const onlyInSent = sent.messages.filter(m => !receivedHashes.has(hashContent(`${m.role}:${m.content}`)));
  const onlyInReceived = received.messages.filter(m => !sentHashes.has(hashContent(`${m.role}:${m.content}`)));
  
  return JSON.stringify({
    sentOnly: onlyInSent.length,
    receivedOnly: onlyInReceived.length,
    sentTokens: sent.tokensSent,
    receivedTokens: received.tokensReceived,
    truncated: sent.truncated || received.truncated,
  });
}

// ─── Snapshot ─────────────────────────────────────────────────────────────────

export interface ContextWindowSnapshot {
  fillPercent: number;
  tokensAvailable: number;
  tokensUsed: number;
  maxTokens: number;
  fidelity: number;
  fidelityPercent: number;
  tokensSent?: number;
  tokensReceived?: number;
  tokensDropped?: number;
  alert?: boolean;
  threshold?: number;
}

/**
 * Create a context window snapshot
 */
export function createContextSnapshot(
  usedTokens: number,
  maxTokens: number,
  options?: {
    tokensSent?: number;
    tokensReceived?: number;
    threshold?: number;
  }
): ContextWindowSnapshot {
  const fill = calculateContextFill(usedTokens, maxTokens);
  
  let fidelity = 1;
  let fidelityPercent = 100;
  let tokensDropped = 0;
  
  if (options?.tokensSent !== undefined && options?.tokensReceived !== undefined) {
    const fid = calculateContextFidelity(options.tokensSent, options.tokensReceived, maxTokens);
    fidelity = fid.fidelity;
    fidelityPercent = fid.fidelityPercent;
    tokensDropped = fid.tokensDropped;
  }
  
  const threshold = options?.threshold ?? 0.7;
  
  return {
    ...fill,
    maxTokens,
    fidelity,
    fidelityPercent,
    tokensSent: options?.tokensSent,
    tokensReceived: options?.tokensReceived,
    tokensDropped,
    alert: fidelity < threshold,
    threshold,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function hashContent(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
}
