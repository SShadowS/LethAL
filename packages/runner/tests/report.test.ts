import { describe, expect, test } from "bun:test";
import type { AlRunnerCanaryResult } from "../src/al-runner-canary";
import type { PermissionCanaryResult } from "../src/permission-canary";
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
    notInstrumented: { totalFiles: 0, fileCount: 0, siteCount: 0, files: [] },
    untargetedTriggerCount: 0,
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

// ————————————————————————————————————————————————————————————————————————
// R26: `renderConsole` repeats the PERMISSION canary's measured verdict after the score, for the
// same reason the al-runner canary is repeated — it is announced once, right after the lease is
// acquired and before the first mutant, which on a real session is many minutes and a whole mutant
// table before the number it qualifies. Reverting the addition (i.e. `renderConsole` ignoring
// `r.permissionCanary`) reddens every test below.
// ————————————————————————————————————————————————————————————————————————
describe("renderConsole — permission canary reiteration (R26)", () => {
  // A bcdev/authoritative base report: unlike the al-runner canary, this one belongs on an
  // AUTHORITATIVE report — the permission mock is a property of the fenced (bcdev) path.
  const bcdevReport: SessionReport = {
    backend: "bcdev",
    authoritative: true,
    baselineGreen: true,
    batches: 1,
    counts: {
      killed: 3,
      survived: 10,
      noCoverage: 3,
      timeoutKilled: 0,
      knownSurvivors: 0,
      unstable: 0,
      errors: 0,
      deadlineExceeded: 0,
    },
    mutationScore: 3 / 13,
    mutants: [],
    unsupportedTests: [],
    notInstrumented: { totalFiles: 0, fileCount: 0, siteCount: 0, files: [] },
    untargetedTriggerCount: 0,
  };

  test("appends the mocked warning AFTER the score on an authoritative report", () => {
    const canary: PermissionCanaryResult = {
      verdict: "mocked",
      readPermission: false,
      writePermission: false,
      insertSucceeded: false,
      detail: "Sorry, the current permissions prevented the action.",
    };
    const out = renderConsole({ ...bcdevReport, permissionCanary: canary });
    const lines = out.split("\n");
    const scoreLineIdx = lines.findIndex((l) => l.startsWith("score:"));
    const canaryLineIdx = lines.findIndex((l) => l.includes("R26"));
    expect(scoreLineIdx).toBeGreaterThanOrEqual(0);
    expect(canaryLineIdx).toBeGreaterThan(scoreLineIdx);
    // R26 after the R1 correction: a `mocked` verdict now reports a VIOLATED PRECONDITION (the
    // platform stripping even a codeunit that declares `TestPermissions = Disabled`), not the
    // disproved fenced-path-vs-mock story. The consequence line is unchanged — such mutants are
    // still silently unscored.
    expect(out).toContain("PRECONDITION VIOLATED");
    expect(out).toContain("TestPermissions = Disabled");
    expect(out).toContain("UNSCORED");
  });

  test("not-mocked is reported too — silence would be indistinguishable from 'nobody looked'", () => {
    const canary: PermissionCanaryResult = {
      verdict: "not-mocked",
      readPermission: true,
      writePermission: true,
      insertSucceeded: true,
    };
    const out = renderConsole({ ...bcdevReport, permissionCanary: canary });
    expect(out).toContain("R26");
    expect(out).toContain("CAN write its own app's tables");
    // The weaker, honest claim: a clean canary confirms the SERVER's precondition and says nothing
    // about any particular target suite, whose own `TestPermissions` decides that.
    expect(out).toContain("says nothing about any particular target suite");
  });

  test("inconclusive prints its reason AND explicitly disclaims being 'not mocked'", () => {
    const canary: PermissionCanaryResult = {
      verdict: "inconclusive",
      detail: "HTTP 404 — the published LethAL Control app has no PermissionCanary action",
    };
    const out = renderConsole({ ...bcdevReport, permissionCanary: canary });
    expect(out).toContain("could not determine");
    expect(out).toContain("HTTP 404");
    expect(out).toContain('NOT the same as "not mocked"');
  });

  test("omits the reiteration entirely when no permission canary ran", () => {
    const out = renderConsole(bcdevReport);
    expect(out).not.toContain("R26");
    expect(out).not.toContain("permission canary");
  });
});
