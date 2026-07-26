import { describe, expect, test } from "bun:test";
import type { AlRunnerCanaryResult } from "../src/al-runner-canary";
import { renderConsole } from "../src/report";
import type { SessionReport } from "../src/report";

// ————————————————————————————————————————————————————————————————————————
// R7/R8: `renderConsole` repeats the al-runner canary's measured verdict at the END of the
// printed report (after the score line), not just once at session start via console.warn
// (`announceAlRunnerCanary`, cli.ts) — the end of a long run is where a reader actually is.
// Reverting this addition (i.e. `renderConsole` ignoring `r.alRunnerCanary` entirely) would fail
// every test below asserting the R7/R8 lines appear in its output.
// ————————————————————————————————————————————————————————————————————————
describe("renderConsole — al-runner canary reiteration (R7/R8)", () => {
  const baseReport: SessionReport = {
    backend: "al-runner",
    authoritative: false,
    baselineGreen: true,
    batches: 1,
    counts: {
      killed: 1,
      survived: 1,
      noCoverage: 0,
      timeoutKilled: 0,
      knownSurvivors: 0,
      unstable: 0,
      errors: 0,
      deadlineExceeded: 0,
    },
    mutationScore: 0.5,
    mutants: [],
    unsupportedTests: [],
  };

  test("appends both canary lines after the score when the backend is non-authoritative and a canary result is present", () => {
    const canary: AlRunnerCanaryResult = {
      asserterror: "defect-confirmed",
      tableGlobalVar: "defect-not-reproduced",
    };
    const out = renderConsole({ ...baseReport, alRunnerCanary: canary });
    const scoreLineIdx = out.split("\n").findIndex((l) => l.startsWith("score:"));
    const r7LineIdx = out.split("\n").findIndex((l) => l.includes("R7"));
    const r8LineIdx = out.split("\n").findIndex((l) => l.includes("R8"));
    expect(scoreLineIdx).toBeGreaterThanOrEqual(0);
    expect(r7LineIdx).toBeGreaterThan(scoreLineIdx);
    expect(r8LineIdx).toBeGreaterThan(scoreLineIdx);
    expect(out).toContain("CONFIRMED");
    expect(out).toContain("did NOT reproduce");
  });

  test("omits the reiteration entirely when no canary result is present (bcdev session, or the al-runner no-alRunnerPath fallback)", () => {
    const out = renderConsole(baseReport);
    expect(out).not.toContain("R7");
    expect(out).not.toContain("R8");
    expect(out).not.toContain("canary");
  });

  test("omits the reiteration on an authoritative (bcdev) report even if alRunnerCanary were somehow set", () => {
    const canary: AlRunnerCanaryResult = {
      asserterror: "defect-confirmed",
      tableGlobalVar: "defect-confirmed",
    };
    const out = renderConsole({ ...baseReport, authoritative: true, alRunnerCanary: canary });
    expect(out).not.toContain("R7");
    expect(out).not.toContain("R8");
  });

  test("inconclusive verdicts still print something (never silently dropped)", () => {
    const canary: AlRunnerCanaryResult = {
      asserterror: "inconclusive",
      tableGlobalVar: "inconclusive",
      asserterrorDetail: "spawn ENOENT",
      tableGlobalVarDetail: "spawn ENOENT",
    };
    const out = renderConsole({ ...baseReport, alRunnerCanary: canary });
    expect(out).toContain("could not determine");
    expect(out).toContain("spawn ENOENT");
  });
});
