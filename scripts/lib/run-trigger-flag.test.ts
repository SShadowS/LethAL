import { expect, test } from "bun:test";
import { runTriggerFlag } from "./run-trigger-flag";

test("ModifyAll(F, true): the true is the VALUE, not a RunTrigger site", () => {
  expect(runTriggerFlag("ModifyAll", ["F", "true"])).toBeNull();
});

test("ModifyAll(F, V, true) is a RunTrigger site; (F, V) has no flag", () => {
  expect(runTriggerFlag("ModifyAll", ["F", "V", "true"])).toBe("true");
  expect(runTriggerFlag("ModifyAll", ["F", "V", "False"])).toBe("false");
  expect(runTriggerFlag("ModifyAll", ["F", "V"])).toBeNull();
});

test("DeleteAll(true) control: the flag is the first argument", () => {
  expect(runTriggerFlag("DeleteAll", ["true"])).toBe("true");
  expect(runTriggerFlag("DeleteAll", [])).toBeNull();
});
