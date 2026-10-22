import { describe, expect, test } from "bun:test";
import { memberOf } from "./member-key";

describe("R347: a report row's member", () => {
  test("two triggers in one file are two members, not one", () => {
    const a = { procedureName: "", triggerName: "OnInsert" };
    const b = { procedureName: "", triggerName: "OnModify" };
    expect(memberOf(a)).toBe("OnInsert");
    expect(memberOf(a)).not.toBe(memberOf(b));
  });

  test("a procedure row keeps its procedure name; a row with neither is blank", () => {
    expect(memberOf({ procedureName: "Calc", triggerName: "OnRun" })).toBe("Calc");
    expect(memberOf({ procedureName: "Calc" })).toBe("Calc");
    expect(memberOf({})).toBe("");
  });
});
