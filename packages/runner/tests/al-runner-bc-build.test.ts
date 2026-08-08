import { describe, expect, test } from "bun:test";
import type { MutantManifestEntry } from "@lethal/schemata";
import { parseAlRunnerBcBuild } from "../src/al-runner-transport";
import { renderConsole } from "../src/report";
import type { SessionOutcome } from "../src/report";
import { legacyBuildReport } from "./helpers/legacy-report";

/**
 * R129 — recording WHICH BC build produced the verdicts on the al-runner path.
 *
 * The runner announces its selection on every invocation and LethAL threw the line away, so a
 * report named the al-runner BINARY (R123's contract probe) but not the BC RUNTIME that binary
 * executed against — which is the thing the verdicts depend on.
 *
 * The two announcement wordings below are the ones MEASURED on al-runner 2.1.1.0 (2026-08-09), on
 * stderr, not stdout. They are quoted verbatim rather than paraphrased: the whole point of this
 * feature is that a reworded announcement becomes visible, and a test written against a paraphrase
 * would not notice the rewording it exists to catch.
 */

const SELECTING =
  "[bc] no --bc-version given - selecting BC 28.1.49838.50794, the exact build this binary was compiled against. Override with --bc-version.";
const SELECTED =
  "[bc] selected BC 28.1.49838.50794 (C:\\Users\\x\\.local/share/al-runner/artifacts/28.1.49838.50794)";

describe("parseAlRunnerBcBuild (R129)", () => {
  test("reads the build off the `selecting` announcement", () => {
    expect(parseAlRunnerBcBuild(`[r2r] re-execing\n${SELECTING}\n`)).toEqual({
      build: "28.1.49838.50794",
      announcement: SELECTING,
    });
  });

  test("reads the build off the `selected` announcement", () => {
    expect(parseAlRunnerBcBuild(`${SELECTED}\n`)?.build).toBe("28.1.49838.50794");
  });

  test("prefers `selected` over `selecting` — what was used beats what was intended", () => {
    const both = `${SELECTING}\n${SELECTED}\n`;
    expect(parseAlRunnerBcBuild(both)?.announcement).toBe(SELECTED);
  });

  test("returns undefined when the runner said nothing — never a defaulted version", () => {
    // A wrong BC build recorded as fact is worse than an absent one, so there is no fallback here.
    expect(parseAlRunnerBcBuild("al-runner - running 2 bundle(s)\n")).toBeUndefined();
    expect(parseAlRunnerBcBuild("")).toBeUndefined();
  });

  test("does not mistake a version inside a TEST's own failure text for the announcement", () => {
    // The `[bc] ` line-start anchor is what makes this safe. Without it, any test asserting on a
    // version string would be read as the runner's selection.
    const noise = "Assert.AreEqual failed. Expected:<selected BC 1.2.3.4> (Text).\n";
    expect(parseAlRunnerBcBuild(noise)).toBeUndefined();
  });
});

const CAPS_ALRUNNER = {
  coverage: "none",
  deploy: "none",
  isolation: "full-reset",
  authoritative: false,
} as const;

const CAPS_BCDEV = {
  coverage: "procedure",
  deploy: "publish",
  isolation: "session",
  authoritative: true,
} as const;

function entry(id: string): MutantManifestEntry {
  return {
    mutantId: id,
    file: "src/A.Codeunit.al",
    startIndex: 0,
    endIndex: 1,
    startLine: 1,
    operatorName: "lethal.empty-block",
    operatorVersion: "1.0.0",
    astHash: `hash-${id}`,
    objectType: "codeunit",
    codeunitId: 50100,
    codeunitName: "A",
    procedureName: "P",
    originalText: "X();",
    mutatedText: "",
  };
}

function build(caps: typeof CAPS_ALRUNNER | typeof CAPS_BCDEV, over: Record<string, unknown> = {}) {
  const outcomes: SessionOutcome[] = [{ mutant: entry("M0001"), verdict: "killed", batchIndex: 0 }];
  return legacyBuildReport({
    caps,
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

describe("ExecutionContext.bcBuild (R129)", () => {
  const observed = { build: "28.1.49838.50794", announcement: SELECTED };

  test("records the build on the al-runner path, with the runner's own words", () => {
    const r = build(CAPS_ALRUNNER, { alRunnerBcBuild: observed });
    const ctx = r.validity.executionContexts[0];
    expect(ctx?.bcBuild).toBe("28.1.49838.50794");
    expect(ctx?.bcBuildAnnouncement).toBe(SELECTED);
  });

  test("absent when no run announced one", () => {
    expect(build(CAPS_ALRUNNER).validity.executionContexts[0]?.bcBuild).toBeUndefined();
  });

  test("never stamped onto an authoritative (bcdev) context", () => {
    // bcdev's runtime is the container the config names, which the report already identifies.
    // Stamping an al-runner observation there would claim a provenance nothing measured.
    const r = build(CAPS_BCDEV, { alRunnerBcBuild: observed });
    expect(r.validity.executionContexts[0]?.bcBuild).toBeUndefined();
  });

  test("the console names the runtime and quotes the announcement", () => {
    const text = renderConsole(build(CAPS_ALRUNNER, { alRunnerBcBuild: observed }));
    expect(text).toContain("BC RUNTIME");
    expect(text).toContain("28.1.49838.50794");
    expect(text).toContain("selected BC");
  });
});
