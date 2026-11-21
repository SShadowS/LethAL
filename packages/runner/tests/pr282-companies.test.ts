// PR-282: `alRunnerV3.companies`: the config key, the argv, the fingerprint and the refusal pointer. The
// backend-level argv checks (a one-shot call, the serve daemon, a NotRun row) sit beside those rigs, in
// al-runner-v3-backend.test.ts and al-runner-v3-entries.test.ts.
import { describe, expect, test } from "bun:test";
import { companiesPointer, v3CallArgv } from "../src/al-runner-v3-backend";
import { validateAlRunnerV3Config } from "../src/al-runner-v3-config";
import { sessionFingerprint } from "../src/resume";

const base = { packagesDir: "/p", bcVersion: "28.0.46665.47126" };

describe("PR-282: the config key", () => {
  test("absent stays absent, a string is kept", () => {
    expect(validateAlRunnerV3Config(base).companies).toBeUndefined();
    expect("companies" in validateAlRunnerV3Config(base)).toBe(false);
    expect(validateAlRunnerV3Config({ ...base, companies: "CRONUS,Other" }).companies).toBe(
      "CRONUS,Other",
    );
  });
  test("an empty string and a non-string are refused by name", () => {
    for (const bad of ["", "   ", " \t", 3, true, ["A"]])
      expect(() => validateAlRunnerV3Config({ ...base, companies: bad })).toThrow(
        '"alRunnerV3.companies" must be a non-empty string',
      );
  });
});

describe("PR-282: argv, fingerprint, pointer", () => {
  const a = {
    alRunnerPath: "/b",
    codeunitId: 7,
    stopSeconds: 3,
    packagesDir: "/d",
    bcVersion: "28.0.1.2",
    symbols: [],
    activeDir: "/a",
    testDir: "/t",
  };
  test("v3CallArgv passes --companies <value> when set and nothing otherwise", () => {
    const on = v3CallArgv({ ...a, companies: "CRONUS,Other" });
    expect(on[on.indexOf("--companies") + 1]).toBe("CRONUS,Other");
    expect(v3CallArgv(a)).not.toContain("--companies");
  });
  test("the fingerprint changes with the list, and is today's without one", () => {
    const f = {
      projectDir: "/p",
      testDir: "/t",
      backend: "al-runner-v3",
      skipKnownSurvivors: false,
      identityScheme: 1,
      selectorIds: { selectorId: 1, controlId: 2, tableId: 3 },
    };
    const none = sessionFingerprint(f);
    const one = sessionFingerprint({ ...f, v3Companies: "A" });
    const two = sessionFingerprint({ ...f, v3Companies: "A,B" });
    expect(new Set([none, one, two]).size).toBe(3);
    // The digest of these inputs before PR-282 (the field added no key): a key added unconditionally moves it.
    expect(none).toBe("9349b4c9edc905ff2627fabf927415d531d474d105727b56247fe761be5d5154");
    // Built separately: an explicit undefined must add no key, so today's digest does not move.
    expect(sessionFingerprint({ ...f, v3Companies: undefined } as unknown as typeof f)).toBe(
      sessionFingerprint({
        projectDir: "/p",
        testDir: "/t",
        backend: "al-runner-v3",
        skipKnownSurvivors: false,
        identityScheme: 1,
        selectorIds: { selectorId: 1, controlId: 2, tableId: 3 },
      }),
    );
  });
  test("the pointer is added for the Company-table refusal and for no other text", () => {
    expect(
      companiesPointer("NotRun: out-of-scope: FindSet on the Company table: the database may hold"),
    ).toContain("set alRunnerV3.companies to the database's companies (PR-282)");
    expect(companiesPointer("some other refusal")).toBe("");
    expect(companiesPointer(undefined)).toBe("");
  });
});
