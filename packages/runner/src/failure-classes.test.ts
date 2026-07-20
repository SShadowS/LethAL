import { describe, expect, test } from "bun:test";
import { ActivationFailure, PublicationFailure } from "./failure-classes";

describe("failure classes", () => {
  test("carry their OperationOutcome and message", () => {
    const e = new ActivationFailure("SetActive timed out", "in-flight-unknown");
    expect(e.outcome).toBe("in-flight-unknown");
    expect(e.message).toBe("SetActive timed out");
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("ActivationFailure");
  });

  test("extend Error directly, never each other — instanceof cannot cross-match", () => {
    const a = new ActivationFailure("x", "pre-dispatch-rejected");
    const p = new PublicationFailure("y", "in-flight-unknown");
    expect(a).not.toBeInstanceOf(PublicationFailure);
    expect(p).not.toBeInstanceOf(ActivationFailure);
  });
});
