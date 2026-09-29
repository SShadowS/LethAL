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

/**
 * R338. al-runner 2.12.0, measured 2026-09-29 on the sandbox-app pair (evidence in
 * H:/lethal-coord/tasks-evidence/R-338/). Verbatim apart from the home prefix, shortened to `C:\x\`,
 * and the long warning's tail. `\u2014` and `\u00b7` are the runner's own em dash and middle dot.
 *
 * DEFAULT (no AL_RUNNER_VERBOSE), `--output-json`: stderr carries no `[bc] selected` line, only
 * the warning and the banner. VERBOSE adds `[bc] selected` and two new `[bc]` lines.
 */
const V212_WARNING =
  "[bc] warning: the shipped 28.1 engine variant was built against 28.1.49838.55333, not the selected 28.1.49838.54487 \u2014 different BUILDS of the same minor can still fail to load Microsoft.Dynamics.Nav.CodeAnalysis (it's strong-named per build, not per minor).";
const V212_BANNER = "al-runner 0.0.0-main \u00b7 BC 28.1.49838.54487 \u00b7 2 apps";
const V212_SELECTING =
  "[bc] no --bc-version given \u2014 selecting BC 28.1.49838.54487, the newest version this install ships an engine for (9 engine variant(s) shipped; the matching one is selected automatically below). Override with --bc-version.";
const V212_VARIANT =
  "[bc] selecting engine variant 28.1.49838.55333 for BC 28.1.49838.54487 (this process is currently running the 28.5.54151.55364 variant) \u2014 re-execing.";
const V212_SELECTED = String.raw`[bc] selected BC 28.1.49838.54487 (C:\x\.local/share/al-runner/artifacts\28.1.49838.54487)`;
const V212_ENGINE = String.raw`[provision] BC 28.1.49838.54487 engine artifacts already complete at C:\x\.local/share/al-runner/artifacts\28.1.49838.54487.`;
const V212_DEFAULT_STDERR = [
  V212_WARNING,
  V212_BANNER,
  "[layered] cache HIT LethAL Sandbox App 1.0.0.1 \u2192 LethAL_LethAL_Sandbox_App_1_0_0_1.app (src .app + sidecar symbols, 1126 bytes, 0ms)",
  "[1/2] src \u2014 1 suites",
  "  \u2192 1P/0F/0E across 1 tests, 0 suite errors (6.8s)",
].join("\n");
const V212_VERBOSE = [
  V212_SELECTING,
  V212_VARIANT,
  "[reexec] Re-execing into a shadow runtime dir with the matching BC-minor engine variant",
  V212_SELECTING,
  V212_ENGINE,
  V212_SELECTED,
  V212_WARNING,
  V212_BANNER,
].join("\n");

/** 2.11.0 default stderr, from docs/measurements/README.md "al-runner v2" (R235). */
const V211_DEFAULT_STDERR = [
  String.raw`[bc] selected BC 28.1.49838.54487 (C:\Users\SShadowS\.local/share/al-runner/artifacts\28.1.49838.54487)`,
  "[bc] warning: the shipped 28.1 engine variant was built against 28.1.49838.54368, not the selected 28.1.49838.54487 - ...",
  "al-runner - running 1 bundle(s)",
].join("\n");

describe("parseAlRunnerBcBuild on 2.11 and 2.12 output (R338)", () => {
  test("2.11 default: the `[bc] selected` line, as before", () => {
    expect(parseAlRunnerBcBuild(V211_DEFAULT_STDERR)).toEqual({
      build: "28.1.49838.54487",
      announcement: String.raw`[bc] selected BC 28.1.49838.54487 (C:\Users\SShadowS\.local/share/al-runner/artifacts\28.1.49838.54487)`,
    });
  });

  test("2.12 default: read off the warning, the selected build and never the variant's", () => {
    expect(parseAlRunnerBcBuild(V212_DEFAULT_STDERR)).toEqual({
      build: "28.1.49838.54487",
      announcement: V212_WARNING,
    });
  });

  test("2.12 default without the warning (variant matches): read off the banner", () => {
    expect(parseAlRunnerBcBuild(`${V212_BANNER}\n[1/2] src \u2014 1 suites\n`)).toEqual({
      build: "28.1.49838.54487",
      announcement: V212_BANNER,
    });
  });

  test("2.12 banner with a mangled middle dot still parses", () => {
    expect(
      parseAlRunnerBcBuild("al-runner 2.12.0 \u00c2\u00b7 BC 28.1.49838.54487 ? 2 apps")?.build,
    ).toBe("28.1.49838.54487");
  });

  test("2.12 verbose: `[bc] selected` still wins", () => {
    expect(parseAlRunnerBcBuild(V212_VERBOSE)).toEqual({
      build: "28.1.49838.54487",
      announcement: V212_SELECTED,
    });
  });

  test("2.12 sibling lines are NOT the announcement", () => {
    // The engine variant line names BC 28.1.49838.54487 after `for BC`, not `selecting BC`; the
    // engine directory and the server banner name no selection at all.
    expect(parseAlRunnerBcBuild(V212_VARIANT)).toBeUndefined();
    expect(parseAlRunnerBcBuild(V212_ENGINE)).toBeUndefined();
    expect(
      parseAlRunnerBcBuild("al-runner \u2014 server mode (JSON-RPC over stdin/stdout)"),
    ).toBeUndefined();
    expect(parseAlRunnerBcBuild("al-runner v2.12.0")).toBeUndefined();
    expect(
      parseAlRunnerBcBuild(
        String.raw`    [pkg-cache] C:\x\.local/share/al-runner/artifacts\28.1.49838.54368\platform-apps`,
      ),
    ).toBeUndefined();
  });

  test("the new lines must open the line, so a test's failure text cannot fake them", () => {
    expect(
      parseAlRunnerBcBuild(
        `Expected: ${V212_BANNER}\nError: x [bc] warning: not the selected 1.2.3.4\n`,
      ),
    ).toBeUndefined();
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
