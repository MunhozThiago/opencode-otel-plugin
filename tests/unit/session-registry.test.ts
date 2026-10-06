/**
 * opencode-otel-plugin - Session Registry Tests
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  rememberSession,
  getSessionName,
  getConversationSessionId,
  sessionAttributes,
  clearSessionRegistry,
} from "../../dist/utils/session-registry.js";

describe("session registry", () => {
  beforeEach(() => {
    clearSessionRegistry();
  });

  it("stores and returns the session name", () => {
    rememberSession("ses_1", "My Session");
    expect(getSessionName("ses_1")).toBe("My Session");
  });

  it("keeps the previous name when a blank one arrives", () => {
    rememberSession("ses_1", "Keep me");
    rememberSession("ses_1", "   ");
    expect(getSessionName("ses_1")).toBe("Keep me");
  });

  it("maps conversation id -> session id", () => {
    rememberSession("ses_1", "Named", "conv_1");
    expect(getConversationSessionId("conv_1")).toBe("ses_1");
  });

  it("sessionAttributes returns canonical session.id and session.name", () => {
    rememberSession("ses_1", "Named session");
    expect(sessionAttributes("ses_1")).toEqual({
      "session.id": "ses_1",
      "session.name": "Named session",
    });
  });

  it("omits session.name when unknown and resolves via conversation id", () => {
    expect(sessionAttributes("ses_unknown")).toEqual({ "session.id": "ses_unknown" });
    expect(sessionAttributes(undefined, "conv_1")).toEqual({});
    rememberSession("ses_1", "Via conversation", "conv_1");
    expect(sessionAttributes(undefined, "conv_1")).toEqual({
      "session.id": "ses_1",
      "session.name": "Via conversation",
    });
  });

  it("ignores missing session ids", () => {
    expect(() => rememberSession(undefined, "name")).not.toThrow();
    expect(sessionAttributes(undefined)).toEqual({});
  });

  it("stays bounded by evicting the oldest entry", () => {
    for (let i = 0; i < 1100; i++) {
      rememberSession(`ses_${i}`, `name_${i}`);
    }
    expect(getSessionName("ses_0")).toBeUndefined();
    expect(getSessionName("ses_1099")).toBe("name_1099");
  });
});
