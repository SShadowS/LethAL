import { describe, expect, test } from "bun:test";
import {
  ResourceSelectorRuntimeError,
  assertResourceSelectorRuntime,
} from "../src/resource-selector";

// R583. LethAL's resource selector needs runtime 14.0 (AL0666); below that the run is refused by
// name. R654 S3 kept only this half: `assertResourceSelectorRuntime` serves al-runner-v3's
// serve-entries transport. The rest of this file (the .NET al-runner's deploy, compile-diagnostic
// owners, the CLI refusal and the itest's resource-leg check) went with that backend.

const NEEDS =
  "which the resource selector needs (NavApp.GetResourceAsText, AL0666); set app.json runtime ≥ 17.0 or alRunner.selectorMode static";

describe("R583 §2: assertResourceSelectorRuntime", () => {
  const check = (appJson: Record<string, unknown>) => () =>
    assertResourceSelectorRuntime(appJson, "resource");

  test("1: runtime 13.0 with the resource selector is refused by name; static is not", () => {
    expect(check({ runtime: "13.0" })).toThrow(ResourceSelectorRuntimeError);
    expect(check({ runtime: "13.0" })).toThrow(`runtime 13.0 is below 14.0, ${NEEDS}`);
    expect(() => assertResourceSelectorRuntime({ runtime: "13.0" }, "static")).not.toThrow();
  });

  test("2: runtime 14.0 and 17.0 are allowed", () => {
    expect(check({ runtime: "14.0" })).not.toThrow();
    expect(check({ runtime: "17.0" })).not.toThrow();
  });

  test('3: runtime "9.0" is refused, so the compare is numeric', () => {
    expect(check({ runtime: "9.0" })).toThrow(ResourceSelectorRuntimeError);
  });

  test("4: an unparseable runtime is refused (fail closed)", () => {
    for (const runtime of ["fourteen", "14", 14, null, "", "14.0.1"]) {
      expect(check({ runtime })).toThrow(ResourceSelectorRuntimeError);
    }
  });

  test("5: no runtime field is allowed (al-runner compiles at its newest)", () => {
    expect(check({})).not.toThrow();
  });
});
