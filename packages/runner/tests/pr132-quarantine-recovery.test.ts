// PR-132 (R1113): the recovery steps a quarantined bcdev run prints, and the dry run's whole-suite note.
import { describe, expect, test } from "bun:test";
import { BASELINE_WHOLE_SUITE_NOTE, dryRunTestsLines, quarantineRecoverySteps } from "../src/cli";

const SERVER = "http://bc.example:7049";
const INSTANCE = "BC";
const CONFIG = "/tmp/proj/lethal.config.json";

describe("PR-132: quarantineRecoverySteps", () => {
  test("a quarantined bcdev run gets the restart, then force-reset-lease and clear-quarantine with its own server, instance and config", () => {
    const lines = quarantineRecoverySteps({
      quarantined: true,
      server: SERVER,
      instance: INSTANCE,
      configPath: CONFIG,
    });
    expect(lines[0]).toContain("the run is quarantined. To recover");
    expect(lines[1]).toContain("NST restart (R658)");
    expect(lines[1]).toContain(`restart the BC service tier of ${SERVER} / ${INSTANCE}`);
    expect(lines[2]).toBe(
      `  2. lethal force-reset-lease --server ${SERVER} --instance ${INSTANCE} --config ${CONFIG}`,
    );
    expect(lines[3]).toBe(`  3. lethal clear-quarantine --config ${CONFIG}`);
    expect(lines[4]).toContain("--exclude-test <Codeunit.Method>");
    expect(lines[4]).toContain("--tests-only <glob>");
    expect(lines[4]).toContain("tests-narrowed");
  });

  test("a run that is not quarantined prints nothing", () => {
    expect(
      quarantineRecoverySteps({
        quarantined: false,
        server: SERVER,
        instance: INSTANCE,
        configPath: CONFIG,
      }),
    ).toEqual([]);
  });

  test("a quarantine with no bcdev tier (al-runner) prints nothing", () => {
    expect(
      quarantineRecoverySteps({
        quarantined: true,
        server: undefined,
        instance: undefined,
        configPath: CONFIG,
      }),
    ).toEqual([]);
    expect(
      quarantineRecoverySteps({
        quarantined: true,
        server: SERVER,
        instance: undefined,
        configPath: CONFIG,
      }),
    ).toEqual([]);
  });
});

describe("PR-132: the dry run's whole-suite note", () => {
  test("it says the baseline runs every test, that one hang quarantines the run, and names --tests-only", () => {
    expect(BASELINE_WHOLE_SUITE_NOTE).toContain("the baseline runs every test");
    expect(BASELINE_WHOLE_SUITE_NOTE).toContain("quarantines the whole run (R1113)");
    expect(BASELINE_WHOLE_SUITE_NOTE).toContain("--tests-only <glob>");
  });

  test("bcdev prints the note after the tests line; al-runner-v3 prints the tests line only", () => {
    expect(dryRunTestsLines("bcdev", "/t")).toEqual([
      "tests: /t (the real run tests with this app; a dry run runs none)",
      BASELINE_WHOLE_SUITE_NOTE,
    ]);
    expect(dryRunTestsLines("al-runner-v3", "/t")).toEqual([
      "tests: /t (the real run tests with this app; a dry run runs none)",
    ]);
  });
});
