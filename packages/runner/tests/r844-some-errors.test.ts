import { describe, expect, test } from "bun:test";
import type { MutantManifestEntry } from "@lethal/schemata";
import { renderConsole } from "../src/report";
import type { SessionOutcome } from "../src/report";
import { legacyBuildReport } from "./helpers/legacy-report";

/**
 * R844: a run where some mutants are `error` and some are not. The errored ones are outside
 * `mutationScore`, so the report says so with the `some-errors` caveat and, in the console, the
 * range the score could read had they run. The worked example is a measured run (R841, shape 1,
 * no symbol): 6 killed, 1 survived, 1 error is 6/7 = 85.7%; had the error survived 6/8 = 75.0%,
 * had it been killed 7/8 = 87.5%.
 */

const CAPS = {
  coverage: "procedure",
  deploy: "publish",
  isolation: "session",
  kind: "bcdev",
  authoritative: true,
} as const;

function entry(id: string): MutantManifestEntry {
  return {
    mutantId: id,
    file: "src/A.al",
    startIndex: 10,
    endIndex: 20,
    startLine: 3,
    operatorName: "lethal.empty-block",
    operatorVersion: "1.0.0",
    astHash: `hash-${id}`,
    objectType: "codeunit",
    codeunitId: 79600,
    codeunitName: "A",
    procedureName: "P",
    originalText: "x",
    mutatedText: "",
  };
}

type Verdict = SessionOutcome["verdict"];

function build(verdicts: readonly (Verdict | readonly [Verdict, string])[]) {
  const outcomes = verdicts.map((v, i): SessionOutcome => {
    const [verdict, cause] = typeof v === "string" ? [v, undefined] : v;
    return {
      mutant: entry(`M${String(i + 1).padStart(4, "0")}`),
      verdict,
      batchIndex: 0,
      ...(cause !== undefined ? { cause } : {}),
    } as SessionOutcome;
  });
  return legacyBuildReport({
    caps: CAPS,
    baselineGreen: true,
    batches: 1,
    outcomes,
    unsupportedTests: [],
    notInstrumented: { totalFiles: 1, files: [] },
    timings: { totalMs: 0, generateMutationSetMs: 0, deployMs: 0, baselineMs: 0 },
    preprocessorSymbols: [],
    untargetedTriggerCount: 0,
    baselineTests: [],
  });
}

const worked: Verdict[] = [
  "killed",
  "killed",
  "killed",
  "killed",
  "killed",
  "killed",
  "survived",
  "error",
];

const lineAfterScore = (text: string) => {
  const lines = text.split("\n");
  const i = lines.findIndex((l) => l.startsWith("score:"));
  return lines[i + 1] ?? "";
};

describe("R844: some-errors", () => {
  test("fires when some rows are error and some are not, and moves nothing else", () => {
    const r = build(worked);
    expect(r.validity.caveats).toContain("some-errors");
    expect(r.validity.caveats).not.toContain("all-errors");
    // The score, the reliability and the exit-code caveat are exactly what they were.
    expect(r.mutationScore).toBeCloseTo(6 / 7, 10);
    expect(r.validity.reliability).toBe("full");
    expect(r.counts.errors).toBe(1);
  });

  test("does not fire when no row is an error", () => {
    const r = build(["killed", "survived", "no-coverage"]);
    expect(r.validity.caveats).not.toContain("some-errors");
    expect(renderConsole(r)).not.toContain("errored and are not in the score");
  });

  test("does not fire when every row is an error; all-errors still does", () => {
    const r = build(["error", "error"]);
    expect(r.validity.caveats).toContain("all-errors");
    expect(r.validity.caveats).not.toContain("some-errors");
    expect(renderConsole(r)).not.toContain("errored and are not in the score");
  });

  test("the range line sits right after the score line, with the worked example's numbers", () => {
    const text = renderConsole(build(worked));
    expect(lineAfterScore(text)).toBe(
      "1 mutant(s) errored and are not in the score; had they run, it would read 75.0% to 87.5%.",
    );
  });

  test("denominator 0: the score is n/a, the count is printed, and the range is 0% to 100%", () => {
    // One error and one no-coverage: nothing scored, but not all-errors.
    const r = build(["error", "no-coverage"]);
    expect(r.mutationScore).toBeNull();
    expect(r.validity.caveats).toContain("some-errors");
    const text = renderConsole(r);
    expect(text).toContain("score: n/a");
    expect(lineAfterScore(text)).toBe(
      "1 mutant(s) errored and are not in the score; had they run, it would read 0.0% to 100.0%.",
    );
  });

  test("a deadline-exceeded row is one of the N, and the line says so", () => {
    // `counts.errors` holds the deadline-exceeded rows, and `mutationScore` leaves exactly those out.
    const r = build(["killed", "survived", ["error", "deadline-exceeded"], "error"]);
    expect(r.counts.errors).toBe(2);
    expect(r.counts.deadlineExceeded).toBe(1);
    // 1 killed, 1 survived, N = 2: low 1/4, high 3/4.
    expect(lineAfterScore(renderConsole(r))).toBe(
      "2 mutant(s) errored (1 deadline-exceeded and 0 unstable are among them) and are not in the score; had they run, it would read 25.0% to 75.0%.",
    );
  });
});
