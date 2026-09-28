import { describe, expect, test } from "bun:test";
import { formatHangLegFailureDiagnostics } from "./hang-diagnostics";

describe("formatHangLegFailureDiagnostics", () => {
  test("one stranded error mutant: its recorded failureMessage (with the watchdog's progress row) survives into the printed text", () => {
    const out = formatHangLegFailureDiagnostics({
      leg: "stop-hung-sessions ON",
      errorMutants: [
        {
          mutantCode: "M0004",
          failureMessages: [
            "RunMutantMany aborted at the hard cap (330000 ms) before headers: Error: aborted. progress row: running at method 1, last completed 0;",
          ],
        },
      ],
      quarantine: [],
      warnings: [],
    });
    expect(out).toContain("M0004");
    expect(out).toContain("progress row:");
  });

  test("no error mutants prints an explicit none, not a blank section", () => {
    const out = formatHangLegFailureDiagnostics({
      leg: "x",
      errorMutants: [],
      quarantine: [],
      warnings: [],
    });
    expect(out).toContain("error mutants: none");
  });

  test("an error mutant with no matching test_results row says so rather than an empty block", () => {
    const out = formatHangLegFailureDiagnostics({
      leg: "x",
      errorMutants: [{ mutantCode: "M0009", failureMessages: [] }],
      quarantine: [],
      warnings: [],
    });
    expect(out).toContain("M0009");
    expect(out).toContain("no test_results row for this mutant");
  });

  test("a quarantine record's detail is printed in full, alongside its generation", () => {
    const out = formatHangLegFailureDiagnostics({
      leg: "x",
      errorMutants: [],
      quarantine: [
        {
          resourceKey: "k1",
          opKind: "run",
          detail: "stuck at method 1, StopSession refused",
          recordedAtIso: "2026-09-27T00:00:00Z",
          generation: 3,
        },
      ],
      warnings: [],
    });
    expect(out).toContain("stuck at method 1, StopSession refused");
    expect(out).toContain("generation=3");
  });

  test("no quarantine records prints an explicit none", () => {
    const out = formatHangLegFailureDiagnostics({
      leg: "x",
      errorMutants: [],
      quarantine: [],
      warnings: [],
    });
    expect(out).toContain("quarantine records: none");
  });

  test("warnings are printed with their code and message", () => {
    const out = formatHangLegFailureDiagnostics({
      leg: "x",
      errorMutants: [],
      quarantine: [],
      warnings: [
        { code: "al-runner-platform-apps-unpinned", message: "no provisioning sentence found" },
      ],
    });
    expect(out).toContain("al-runner-platform-apps-unpinned");
    expect(out).toContain("no provisioning sentence found");
  });

  test("no warnings prints an explicit none", () => {
    const out = formatHangLegFailureDiagnostics({
      leg: "x",
      errorMutants: [],
      quarantine: [],
      warnings: [],
    });
    expect(out).toContain("warnings: none");
  });

  test("the leg label names which leg failed", () => {
    const out = formatHangLegFailureDiagnostics({
      leg: "stop-hung-sessions OFF",
      errorMutants: [],
      quarantine: [],
      warnings: [],
    });
    expect(out).toContain("stop-hung-sessions OFF");
  });
});
