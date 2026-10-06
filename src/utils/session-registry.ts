/**
 * opencode-otel-plugin - Session Registry
 *
 * Bounded in-memory mapping of session/conversation ids to session names.
 * Populated from session.created / session.updated events and read by the
 * span processor, metrics, and logs so every signal carries:
 *   - session.id    (canonical, alongside the existing gen_ai.session.id)
 *   - session.name  (session title, for filtering in the backend)
 */

const MAX_ENTRIES = 1000;

const sessionNames = new Map<string, string>();
const conversationSessions = new Map<string, string>();

function setBounded(map: Map<string, string>, key: string, value: string): void {
  if (!map.has(key) && map.size >= MAX_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

export function rememberSession(
  sessionId: string | undefined | null,
  name?: string | null,
  conversationId?: string | null
): void {
  if (!sessionId) return;
  if (typeof name === "string" && name.trim()) {
    setBounded(sessionNames, sessionId, name.trim());
  }
  if (conversationId) {
    setBounded(conversationSessions, conversationId, sessionId);
  }
}

export function getSessionName(sessionId: string | undefined | null): string | undefined {
  return sessionId ? sessionNames.get(sessionId) : undefined;
}

export function getConversationSessionId(
  conversationId: string | undefined | null
): string | undefined {
  return conversationId ? conversationSessions.get(conversationId) : undefined;
}

/** Canonical session attributes for spans / metrics / logs (only known values). */
export function sessionAttributes(
  sessionId?: string | null,
  conversationId?: string | null
): Record<string, string> {
  const sid = sessionId ?? getConversationSessionId(conversationId);
  const out: Record<string, string> = {};
  if (sid) {
    out["session.id"] = sid;
    const name = getSessionName(sid);
    if (name) out["session.name"] = name;
  }
  return out;
}

export function clearSessionRegistry(): void {
  sessionNames.clear();
  conversationSessions.clear();
}
