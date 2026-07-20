import { describe, expect, test } from "bun:test";
import { SessionSafety, SessionUnsafeError } from "./session-safety";

describe("SessionSafety", () => {
  test("starts safe; assertSafe is a no-op before latch", () => {
    const s = new SessionSafety();
    expect(s.isUnsafe).toBe(false);
    expect(() => s.assertSafe("activate")).not.toThrow();
  });

  test("latch is one-way and records the first reason", () => {
    const s = new SessionSafety();
    s.latchUnsafe("deadline exceeded on M0007");
    s.latchUnsafe("something later"); // must not overwrite
    expect(s.isUnsafe).toBe(true);
    expect(s.reason).toBe("deadline exceeded on M0007");
  });

  test("assertSafe throws SessionUnsafeError after latch, naming the op and reason", () => {
    const s = new SessionSafety();
    s.latchUnsafe("deadline exceeded on M0007");
    let caught: unknown;
    try {
      s.assertSafe("activate(null)");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SessionUnsafeError);
    expect((caught as Error).message).toContain("activate(null)");
    expect((caught as Error).message).toContain("deadline exceeded on M0007");
  });
});
