import { describe, expect, test } from "bun:test";
import type { MutantManifestEntry } from "@lethal/schemata";
import { renderConsole } from "../src/report";
import type { SessionOutcome } from "../src/report";
import { legacyBuildReport } from "./helpers/legacy-report";

/**
 * R60. LethAL executes every mutant headlessly — the fenced `RunMutant` path runs as
 * `GuiAllowed=No`, `ClientType=ODataV4` (measured under R57), and al-runner is a headless CLI. A
 * developer running the same suite from VS Code runs GUI-allowed, so the two are not measuring the
 * same branches of the same app, and nothing in the report said so.
 *
 * Why a stated limit and not a per-site signal: measured with `scripts/measure-gui-guarded.ts`
 * against Continia Document Output (`DocumentOutput/Cloud`, 551 `.al` files, 2026-07-31), 62 of
 * 19,850 mutation sites — 0.3% — sit lexically inside a `GuiAllowed`/`Confirm`-guarded branch.
 * 0.3% does not justify machinery, and the fact is structural: no LethAL backend runs GUI-allowed,
 * so there is nothing to detect per run.
 */

const CAPS_AUTHORITATIVE = {
  coverage: "procedure",
  deploy: "publish",
  isolation: "session",
  authoritative: true,
} as const;

const CAPS_AL_RUNNER = { ...CAPS_AUTHORITATIVE, authoritative: false } as const;

function entry(): MutantManifestEntry {
  return {
    mutantId: "M0001",
    file: "src/A.Codeunit.al",
    startIndex: 0,
    endIndex: 1,
    startLine: 1,
    operatorName: "lethal.empty-block",
    operatorVersion: "1.0.0",
    astHash: "hash",
    objectType: "codeunit",
    codeunitId: 50100,
    codeunitName: "A",
    procedureName: "P",
    originalText: "Original();",
    mutatedText: "",
  };
}

function build(over: Record<string, unknown> = {}) {
  const outcomes: SessionOutcome[] = [{ mutant: entry(), verdict: "killed", batchIndex: 0 }];
  return legacyBuildReport({
    caps: CAPS_AUTHORITATIVE,
    baselineGreen: true,
    batches: 1,
    outcomes,
    unsupportedTests: [],
    notInstrumented: { totalFiles: 1, files: [] },
    timings: { totalMs: 0, generateMutationSetMs: 0, deployMs: 0, baselineMs: 0 },
    untargetedTriggerCount: 0,
    baselineTests: [{ codeunitName: "Tests" }],
    ...over,
  });
}

describe("validity.executionContexts (R60, widened by R69 Phase 2 Task 5)", () => {
  // The whole point: this is not conditional on anything. A clean, full-reliability run is exactly
  // the one whose reader is most likely to quote the score without qualification.
  test("is present on a FULL-reliability run, not only a degraded one", () => {
    const r = build();
    expect(r.validity.reliability).toBe("full");
    const ctx = r.validity.executionContexts.find((c) => c.runner === "fenced");
    expect(ctx?.guiAllowed).toBe(false);
    expect(ctx?.clientType).toBe("ODataV4");
  });

  // The two backends are known by DIFFERENT evidence. R57 measured the fenced path directly;
  // al-runner is inferred from being a CLI. Reporting both as "measured" would be the static claim
  // R7/R8 exist to stop, so the basis has to differ.
  test("names the fenced path's MEASURED basis on the authoritative backend", () => {
    const r = build();
    const ctx = r.validity.executionContexts.find((c) => c.runner === "fenced");
    expect(ctx?.basis).toContain("measured");
    expect(ctx?.basis).toContain("R57");
  });

  test("does not claim al-runner was measured the same way", () => {
    const r = build({ caps: CAPS_AL_RUNNER });
    const ctx = r.validity.executionContexts.find((c) => c.runner === "fenced");
    expect(ctx?.guiAllowed).toBe(false);
    expect(ctx?.clientType).toBe("al-runner CLI");
    expect(ctx?.basis).toContain("not separately measured");
  });

  test("the console states it on every run, including a clean one", () => {
    const text = renderConsole(build());
    expect(text).toContain("NON-GUI EXECUTION");
    // The consequence, not just the fact — a reader who sees only "GuiAllowed=No" learns nothing.
    expect(text).toContain("cannot be killed");
    // Confirm and Page.RunModal behave DIFFERENTLY from each other; collapsing them into "GUI
    // code doesn't run" is the imprecision that makes the caveat useless.
    expect(text).toContain("DEFAULT");
    expect(text).toContain("Page.RunModal ERRORS");
    // The measured figure, so the caveat is neither alarmism nor complacency.
    expect(text).toContain("0.3%");
  });

  test("the console line survives a degraded run alongside the SCOPE line", () => {
    const text = renderConsole(build({ baselineGreen: false }));
    expect(text).toContain("NON-GUI EXECUTION");
    expect(text).toContain("SCOPE:");
  });
});

/**
 * R53, spec §5: "this verdict is evidentially weaker than every other kill, and the report must
 * say so."
 *
 * A `timeout-killed` scored through `--stop-hung-sessions` rests on BC confirming it stopped the
 * session — not on a failing assertion, and not on any attestation (`ObservedAny` lives in a
 * SingleInstance codeunit's memory and dies with the stopped session, so the run cannot even say
 * whether an instrumented site executed). It is also permanent: the verdict is carryable.
 */
describe("validity caveat: stop-hung-sessions (R53)", () => {
  function withTimeoutKill(over: Record<string, unknown> = {}) {
    const outcomes: SessionOutcome[] = [
      { mutant: entry(), verdict: "timeout-killed", batchIndex: 0 },
    ];
    return build({ outcomes, ...over });
  }

  test("fires when the flag actually produced a timeout-killed", () => {
    expect(withTimeoutKill({ stopHungSessions: true }).validity.caveats).toContain(
      "stop-hung-sessions",
    );
  });

  // The flag alone is a setting; a scored timeout is a CLAIM, and it is the claim that needs
  // qualifying. A caveat on every flagged run would be noise on the runs that scored nothing.
  test("does NOT fire when the flag was on but nothing timed out", () => {
    expect(build({ stopHungSessions: true }).validity.caveats).not.toContain("stop-hung-sessions");
  });

  test("does NOT fire when a timeout-killed exists without the flag", () => {
    expect(withTimeoutKill().validity.caveats).not.toContain("stop-hung-sessions");
  });
});
