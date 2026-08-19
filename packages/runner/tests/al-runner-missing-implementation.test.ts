import { describe, expect, test } from "bun:test";
import { parseAlRunnerMissingImplementation } from "../src/al-runner-transport";

/**
 * R148. al-runner prints this on every `itest:alrunner` invocation and nothing read it for months.
 *
 * The line is captured verbatim from a real run against al-runner 2.1.2.0, 2026-08-15, wrapped
 * exactly as the runner wraps it — the parser must key on the FIRST line only, because that is
 * where the app name and the phrase both sit.
 */
const REAL_LINE = `[dep] LethAL/LethAL Sandbox App v1.0.0.999 resolved to a package with NO IMPLEMENTATION (no publishedartifacts DLL,
      no src/*.al) and no other copy was found in the package caches:
      winner: U:\\Git\\LethAL\\fixtures\\sandbox-tests\\.alpackages\\LethAL_LethAL Sandbox App_1.0.0.999.app
      Calls into this app will fail with "The object with ID 0 does not
      have a member with that ID". Provision a package that carries an
      implementation - \`al-runner provision\`, or re-run with --auto-provision;`;

describe("parseAlRunnerMissingImplementation (R148)", () => {
  test("reads the app name out of a real runner warning", () => {
    const found = parseAlRunnerMissingImplementation(
      `[r2r] re-execing\n${REAL_LINE}\n[bc] selected BC 28.1.0.0`,
    );
    expect(found?.app).toBe("LethAL/LethAL Sandbox App v1.0.0.999");
    expect(found?.announcement).toContain("NO IMPLEMENTATION");
  });

  test("answers undefined when the runner said nothing", () => {
    // Absence must mean "the runner did not say it", never "there is no problem". A defaulted
    // answer here would turn a silent release change into a clean report.
    expect(
      parseAlRunnerMissingImplementation("[bc] selected BC 28.1.0.0\nall good"),
    ).toBeUndefined();
  });

  test("is anchored at line start, so a TEST's own failure text cannot forge it", () => {
    // The exact hazard `parseAlRunnerBcBuild` documents for `[bc] `: a test that prints the phrase
    // must not be read as the runner announcing it.
    const forged =
      'FAIL SomeTest: expected "[dep] Evil resolved to a package with NO IMPLEMENTATION"';
    expect(parseAlRunnerMissingImplementation(forged)).toBeUndefined();
  });

  test("takes the FIRST occurrence, since the runner repeats it per invocation", () => {
    const two = `${REAL_LINE}\n[dep] Other/App v2 resolved to a package with NO IMPLEMENTATION (…)`;
    expect(parseAlRunnerMissingImplementation(two)?.app).toBe(
      "LethAL/LethAL Sandbox App v1.0.0.999",
    );
  });
});
