import { describe, expect, test } from "bun:test";
import { weakerStopEvidence } from "../src/backend";

describe("weakerStopEvidence (GitHub #49)", () => {
  test("any 400 evidence wins", () => {
    expect(weakerStopEvidence("bc-named-stop", "begin-transaction-world")).toBe(
      "begin-transaction-world",
    );
    expect(weakerStopEvidence("begin-transaction-world", "bc-named-stop")).toBe(
      "begin-transaction-world",
    );
    expect(weakerStopEvidence("begin-transaction-world", undefined)).toBe(
      "begin-transaction-world",
    );
    expect(weakerStopEvidence(undefined, "begin-transaction-world")).toBe(
      "begin-transaction-world",
    );
  });

  test("WE1. a 408 and no evidence keeps the 408", () => {
    expect(weakerStopEvidence("bc-named-stop", undefined)).toBe("bc-named-stop");
  });

  test("WE2. no evidence and a 408 keeps the 408", () => {
    expect(weakerStopEvidence(undefined, "bc-named-stop")).toBe("bc-named-stop");
  });

  test("two 408s and two nones", () => {
    expect(weakerStopEvidence("bc-named-stop", "bc-named-stop")).toBe("bc-named-stop");
    expect(weakerStopEvidence(undefined, undefined)).toBeUndefined();
  });
});
