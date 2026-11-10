import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IDENTITY_SCHEME, type MutantManifestEntry } from "@lethal/schemata";
import type { SessionOutcome } from "../src/report";
import { sessionFingerprint } from "../src/resume";
import {
  V3VerdictsError,
  type V3VerdictsInput,
  checkV3Rows,
  checkV3Verdicts,
  joinV3Verdicts,
  loadV3Verdicts,
} from "../src/v3-verdicts";
import { removeScratchDir } from "./helpers/scratch";

const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) await removeScratchDir(r);
});

const REFUSED = "Page Tests.OpensCard";
const entry = (id: string, over: Partial<MutantManifestEntry> = {}): MutantManifestEntry =>
  ({
    mutantId: id,
    file: "src/A.al",
    startIndex: 10,
    endIndex: 20,
    startLine: 3,
    operatorName: "lethal.op",
    operatorVersion: "1.0.0",
    astHash: `hash-${id}`,
    objectType: "codeunit",
    codeunitId: 50100,
    codeunitName: "A",
    procedureName: "P",
    procedureScope: "public",
    originalText: "x",
    mutatedText: "y",
    ...over,
  }) as MutantManifestEntry;

const v3Row = (id: string, over: Record<string, unknown> = {}) => ({
  mutantCode: id,
  file: "src/A.al",
  startIndex: 10,
  endIndex: 20,
  mutatedText: "y",
  operatorName: "lethal.op",
  operatorMajor: 1,
  astHash: `hash-${id}`,
  codeunitName: "A",
  procedureName: "P",
  verdict: "killed",
  killingTest: REFUSED,
  coveringTests: [REFUSED],
  ...over,
});

const goodReport = (over: Record<string, unknown> = {}) => ({
  backend: "al-runner-v3",
  identityScheme: IDENTITY_SCHEME,
  coverageMode: "al-runner",
  sourceSha256: "src",
  numberingDigest: "num",
  testSourceSha256: "tst",
  unsupportedTests: [],
  testMethods: [{ name: REFUSED }],
  mutants: [v3Row("M1")],
  validity: { executionContexts: [{ runnerBuild: "build-1" }] },
  ...over,
});

async function write(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lethal-v3v-"));
  roots.push(dir);
  const p = join(dir, "v3.report.json");
  await writeFile(p, body);
  return p;
}
const load = async (over: Record<string, unknown> = {}) =>
  loadV3Verdicts(await write(JSON.stringify(goodReport(over))));

async function reasonsOf(p: Promise<unknown>): Promise<string> {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(V3VerdictsError);
  return (e as V3VerdictsError).reasons.join("; ");
}

describe("loadV3Verdicts refuses by name", () => {
  test("a good report loads, with its sha and build", async () => {
    const input = await load();
    expect(input.reportSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(input.runnerBuild).toBe("build-1");
    expect(input.rows.size).toBe(1);
  });
  test("an unreadable file", async () => {
    expect(await reasonsOf(loadV3Verdicts("/nonexistent/v3.json"))).toContain("cannot be read");
  });
  test("not JSON", async () => {
    expect(await reasonsOf(loadV3Verdicts(await write("{")))).toContain("not JSON");
  });
  for (const [name, over, text] of [
    ["another backend", { backend: "bcdev" }, "not al-runner-v3"],
    ["another identity scheme", { identityScheme: IDENTITY_SCHEME - 1 }, "identity scheme"],
    ["coverage none", { coverageMode: "none" }, "coverage was off"],
    ["coverage turned off", { coverageOffFiles: ["a.al"] }, "coverage was off"],
    ["--tests-only", { testsOnly: ["a"] }, "--tests-only"],
    ["a quarantined run", { quarantined: { reason: "x" } }, "quarantined"],
    ["no sourceSha256", { sourceSha256: undefined }, "no sourceSha256"],
    ["no numberingDigest", { numberingDigest: undefined }, "no numberingDigest"],
    ["no testSourceSha256", { testSourceSha256: undefined }, "no testSourceSha256"],
    ["no mutants", { mutants: undefined }, "no mutants"],
    ["a repeated key", { mutants: [v3Row("M1"), v3Row("M1")] }, "repeat"],
  ] as const) {
    test(name, async () => {
      const p = await write(JSON.stringify(goodReport(over as Record<string, unknown>)));
      expect(await reasonsOf(loadV3Verdicts(p))).toContain(text);
    });
  }
  test("an empty testsOnly is not a narrowing", async () => {
    expect((await load({ testsOnly: [] })).rows.size).toBe(1);
  });
});

describe("checkV3Verdicts: this run's facts", () => {
  const facts = {
    sourceSha256: "src",
    numberingDigest: "num",
    testSourceSha256: "tst",
    refusedTests: [REFUSED],
    deployedCount: 1,
  };
  const reasons = (input: V3VerdictsInput, over: Partial<typeof facts>): string => {
    try {
      checkV3Verdicts(input, { ...facts, ...over });
    } catch (e) {
      expect(e).toBeInstanceOf(V3VerdictsError);
      return (e as V3VerdictsError).reasons.join("; ");
    }
    return "";
  };
  test("equal facts pass", async () => {
    expect(reasons(await load(), {})).toBe("");
  });
  test("fewer rows than this run deploys, before any batch", async () => {
    expect(reasons(await load(), { deployedCount: 2 })).toContain("1 rows for this run's 2");
  });
  test("a different source", async () => {
    expect(reasons(await load(), { sourceSha256: "other" })).toContain("sourceSha256");
  });
  test("different numbering", async () => {
    expect(reasons(await load(), { numberingDigest: "other" })).toContain("numberingDigest");
  });
  test("a different test app", async () => {
    expect(reasons(await load(), { testSourceSha256: "other" })).toContain("testSourceSha256");
  });
  test("no refused test passed on v3: unsupported", async () => {
    expect(reasons(await load({ unsupportedTests: [REFUSED] }), {})).toContain("none of the tests");
  });
  test("no refused test passed on v3: not in the report's tests", async () => {
    expect(reasons(await load({ testMethods: [{ name: "Other.T" }] }), {})).toContain(
      "none of the tests",
    );
  });
  test("one of two refused tests green is enough", async () => {
    const input = await load({ unsupportedTests: ["Page Tests.Other"] });
    expect(reasons(input, { refusedTests: [REFUSED, "Page Tests.Other"] })).toBe("");
  });
  test("no refused test at all is not a refusal", async () => {
    expect(reasons(await load({ unsupportedTests: [REFUSED] }), { refusedTests: [] })).toBe("");
  });
});

describe("checkV3Rows: every row of a batch is the same site", () => {
  let input0: V3VerdictsInput;
  beforeAll(async () => {
    input0 = await load();
  });
  test("the same site passes", () => {
    expect(() => checkV3Rows(input0, [entry("M1")])).not.toThrow();
  });
  test.each([
    ["file", { file: "src/B.al" }],
    ["startIndex", { startIndex: 11 }],
    ["endIndex", { endIndex: 21 }],
    ["mutatedText", { mutatedText: "z" }],
  ] as const)("a different %s refuses", (_n, over) => {
    expect(() => checkV3Rows(input0, [entry("M1", over)])).toThrow(/different site or text for M1/);
  });
  test("a Windows path in the run matches the report's forward slashes", () => {
    expect(() => checkV3Rows(input0, [entry("M1", { file: "src\\A.al" })])).not.toThrow();
  });
  test("a mutant with no row refuses", () => {
    expect(() => checkV3Rows(input0, [entry("M9")])).toThrow(/no row for M9/);
  });
  test("a report with redacted text refuses", async () => {
    const redacted = await load({ mutants: [v3Row("M1", { mutatedText: undefined })] });
    expect(() => checkV3Rows(redacted, [entry("M1")])).toThrow(/different site or text/);
  });
});

describe("joinV3Verdicts", () => {
  const out = (id: string, over: Partial<SessionOutcome> = {}): SessionOutcome =>
    ({ mutant: entry(id), verdict: "no-coverage", batchIndex: 0, ...over }) as SessionOutcome;
  const join1 = async (
    v3: Record<string, unknown>,
    outcome: SessionOutcome = out("M1"),
    unplaceable: ReadonlySet<string> = new Set(),
  ) =>
    joinV3Verdicts(await load({ mutants: [v3Row("M1", v3)] }), [outcome], [REFUSED], unplaceable);
  const EMPTY = { survived: 0, timeoutKilled: 0, otherVerdict: 0 };

  test("a v3 kill on an eligible row is shown", async () => {
    const j = await join1({});
    expect(j.kills).toEqual([
      { batchIndex: 0, mutantCode: "M1", killingTest: REFUSED, coveringTests: [REFUSED] },
    ]);
    expect(j.notShown).toEqual(EMPTY);
    expect(j.runnerBuild).toBe("build-1");
  });
  test("a v3 survivor is counted, not shown, even with a killingTest on the row", async () => {
    const j = await join1({ verdict: "survived" });
    expect(j.kills).toEqual([]);
    expect(j.notShown).toEqual({ ...EMPTY, survived: 1 });
  });
  test("a v3 timeout is counted, not shown", async () => {
    const j = await join1({ verdict: "timeout-killed" });
    expect(j.kills).toEqual([]);
    expect(j.notShown).toEqual({ ...EMPTY, timeoutKilled: 1 });
  });
  test("any other v3 verdict is counted, not shown", async () => {
    const j = await join1({ verdict: "error" });
    expect(j.kills).toEqual([]);
    expect(j.notShown).toEqual({ ...EMPTY, otherVerdict: 1 });
  });
  // R-911 ruling 4: a mutant that reaches a call al-runner refuses under --no-client is a "not run"
  // row (R-907: `error`, cause `runner-refused`, `NotRun: out-of-scope: ...`). Never a kill.
  test("a v3 'not run' refusal is counted, never shown as a kill", async () => {
    const j = await join1({
      verdict: "error",
      cause: "runner-refused",
      failureNote:
        "NotRun: out-of-scope: Page.Run with a record in a session without a client (--no-client)",
    });
    expect(j.kills).toEqual([]);
    expect(j.notShown).toEqual({ ...EMPTY, otherVerdict: 1 });
  });
  test("a v3 'killed' with no killing test is not shown", async () => {
    const j = await join1({ killingTest: undefined });
    expect(j.kills).toEqual([]);
    expect(j.notShown).toEqual({ ...EMPTY, otherVerdict: 1 });
  });
  const none = { kills: [], notShown: EMPTY };
  test("a bcdev row that is not no-coverage is left alone", async () => {
    expect(await join1({}, out("M1", { verdict: "survived" }))).toMatchObject(none);
  });
  test("a no-coverage row with a named cause is left alone", async () => {
    expect(await join1({}, out("M1", { failureNote: "refused object" }))).toMatchObject(none);
  });
  test("an unplaceable row is left alone, in its own batch only", async () => {
    expect(await join1({}, out("M1"), new Set(["0\0M1"]))).toMatchObject(none);
    expect((await join1({}, out("M1"), new Set(["1\0M1"]))).kills).toHaveLength(1);
  });
  test("a row v3 did not cover is left alone", async () => {
    expect(await join1({ coveringTests: [] })).toMatchObject(none);
  });
  test("a row covered by a test BC did not refuse is left alone", async () => {
    expect(await join1({ coveringTests: [REFUSED, "Plain.T"] })).toMatchObject(none);
  });
  test("names the refused tests that did not pass on v3", async () => {
    const input = await load({ unsupportedTests: ["Page Tests.Other"] });
    const j = joinV3Verdicts(input, [], [REFUSED, "Page Tests.Other"], new Set());
    expect(j.refusedTestsNotGreenOnV3).toEqual(["Page Tests.Other"]);
  });
});

describe("the resume fingerprint", () => {
  const base = {
    projectDir: "p",
    testDir: "t",
    backend: "bcdev",
    skipKnownSurvivors: false,
    identityScheme: 48,
    selectorIds: { selectorId: 1, controlId: 2, tableId: 3 },
  } as Parameters<typeof sessionFingerprint>[0];
  test("a run without the flag keeps its digest; a different report changes it", () => {
    const none = sessionFingerprint(base);
    // Pinned: stored runs must keep resuming, so the key must be absent, not empty, without the flag.
    expect(none).toBe("2f4a9594d8e5e0782d77d985eb695e3ed5ed73a8cf255309f3b11adc7698a952");
    const a = sessionFingerprint({ ...base, v3VerdictsSha256: "a" });
    const b = sessionFingerprint({ ...base, v3VerdictsSha256: "b" });
    expect(a).not.toBe(none);
    expect(a).not.toBe(b);
    expect(sessionFingerprint({ ...base })).toBe(none);
  });
});
