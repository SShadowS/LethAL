import { describe, expect, test } from "bun:test";
import type { MutantManifestEntry } from "@lethal/schemata";
import { renderConsole } from "../src/report";
import type { SessionOutcome } from "../src/report";
import { legacyBuildReport } from "./helpers/legacy-report";

/**
 * R72 — the SCREEN over kills the platform produced, and the rule it must never break.
 *
 * The rule: a diagnosis does not move a verdict. Every test below that asserts a count also asserts
 * that `mutationScore`, `counts` and the per-mutant `verdict` are exactly what they would be with
 * the tag absent. Re-scoring on a diagnosis would invalidate every frozen gate figure in CLAUDE.md
 * and every committed baseline under docs/campaign/, so the guard against it is a test, not a
 * comment.
 *
 * The tag itself (which sites carry it) is measured and tested one layer down, in
 * `packages/builtin-tier2/tests/write-txn-codeunit-run.test.ts`.
 */

const CAPS = {
  coverage: "procedure",
  deploy: "publish",
  isolation: "session",
  authoritative: true,
} as const;

function entry(id: string, over: Partial<MutantManifestEntry> = {}): MutantManifestEntry {
  return {
    mutantId: id,
    file: "src/CommitOps.Codeunit.al",
    startIndex: 0,
    endIndex: 1,
    startLine: 1,
    operatorName: "lethal.remove-commit",
    operatorVersion: "1.0.0",
    astHash: `hash-${id}`,
    objectType: "codeunit",
    codeunitId: 50100,
    codeunitName: "Commit Ops",
    procedureName: "P",
    originalText: "Commit()",
    mutatedText: "",
    ...over,
  };
}

function build(outcomes: readonly SessionOutcome[]) {
  return legacyBuildReport({
    caps: CAPS,
    baselineGreen: true,
    batches: 1,
    outcomes,
    unsupportedTests: [],
    notInstrumented: { totalFiles: 1, files: [] },
    timings: { totalMs: 0, generateMutationSetMs: 0, deployMs: 0, baselineMs: 0 },
    untargetedTriggerCount: 0,
    baselineTests: [{ codeunitName: "Tests" }],
  });
}

const TAG = { platformKillMechanism: "write-txn-codeunit-run" } as const;

describe("SessionReport.platformArtifactKills (R72)", () => {
  test("screens the killed mutant whose site carries the mechanism, and names it", () => {
    const r = build([
      { mutant: entry("M0001", TAG), verdict: "killed", batchIndex: 0 },
      { mutant: entry("M0002"), verdict: "killed", batchIndex: 0 },
    ]);
    expect(r.platformArtifactKills?.killedCount).toBe(1);
    expect(r.platformArtifactKills?.byMechanism).toEqual([
      {
        mechanism: "write-txn-codeunit-run",
        mutants: ["M0001"],
        // Asserted as a substring rather than verbatim so the wording can be improved without a
        // test edit, but the MEASURED fact it exists to state cannot quietly leave it.
        explanation: expect.stringContaining("return value is consumed") as unknown as string,
      },
    ]);
    expect(r.validity.caveats).toContain("platform-artifact-kills");
  });

  test("does NOT move the verdict, the counts, or the score — this is the whole discipline", () => {
    const tagged: readonly SessionOutcome[] = [
      { mutant: entry("M0001", TAG), verdict: "killed", batchIndex: 0 },
      { mutant: entry("M0002"), verdict: "survived", batchIndex: 0 },
    ];
    const untagged: readonly SessionOutcome[] = [
      { mutant: entry("M0001"), verdict: "killed", batchIndex: 0 },
      { mutant: entry("M0002"), verdict: "survived", batchIndex: 0 },
    ];
    const withTag = build(tagged);
    const without = build(untagged);
    expect(withTag.counts).toEqual(without.counts);
    expect(withTag.mutationScore).toBe(without.mutationScore);
    expect(withTag.mutants.map((m) => m.verdict)).toEqual(without.mutants.map((m) => m.verdict));
    // And the screen really did fire, or the equality above would be proving nothing.
    expect(withTag.platformArtifactKills?.killedCount).toBe(1);
    expect(without.platformArtifactKills).toBeUndefined();
  });

  test("a SURVIVOR at such a site is not screened — the site property alone is not a finding", () => {
    const r = build([{ mutant: entry("M0001", TAG), verdict: "survived", batchIndex: 0 }]);
    expect(r.platformArtifactKills).toBeUndefined();
    expect(r.validity.caveats).not.toContain("platform-artifact-kills");
    // The mutant still carries the site property — it is true of a survivor too, and dropping it
    // would make the report unable to explain why a later run's kill got screened.
    expect(r.mutants[0]?.platformKillMechanism).toBe("write-txn-codeunit-run");
  });

  test("absent — not an empty block — when nothing was screened", () => {
    // An empty block would read as "checked, and every kill was earned". It was not checked: only
    // `lethal.remove-commit` tags sites at all.
    const r = build([{ mutant: entry("M0001"), verdict: "killed", batchIndex: 0 }]);
    expect(r.platformArtifactKills).toBeUndefined();
  });

  test("names an unrecognised tag rather than dropping the mutant from the screen", () => {
    // A manifest written by a different engine version. Silently un-screening a kill because a
    // string is unfamiliar is the empty-vs-empty failure this repo is named for.
    const r = build([
      {
        mutant: entry("M0001", { platformKillMechanism: "some-future-mechanism" }),
        verdict: "killed",
        batchIndex: 0,
      },
    ]);
    expect(r.platformArtifactKills?.killedCount).toBe(1);
    expect(r.platformArtifactKills?.byMechanism[0]?.explanation).toContain("some-future-mechanism");
  });

  test("the console says READ THESE and refuses to call any of them false", () => {
    const text = renderConsole(
      build([{ mutant: entry("M0001", TAG), verdict: "killed", batchIndex: 0 }]),
    );
    expect(text).toContain("PLATFORM-ARTIFACT KILL SCREEN");
    expect(text).toContain("M0001");
    expect(text).toContain("they stay killed");
    // The hedge is the point: a screen that says "these are false kills" is a classifier, and R121
    // measured what happens when a classifier ships on a rule nobody scored.
    expect(text).toContain("does not claim any");
  });
});
