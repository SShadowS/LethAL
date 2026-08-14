/**
 * R31 + R139 - naming the one refusal that looks exactly like a scoring problem.
 *
 * WHY THIS EXISTS. LethAL republishes the instrumented TARGET on every run and treats publishing
 * the TEST app as the operator's own workflow. When the published test app is older than the source
 * being measured, every test the source declares but the app lacks fails at baseline, drops out of
 * the green set, and every mutant covered only by those tests is recorded `no-coverage` (R55). The
 * run then completes and prints a plausible aggregate that is quietly missing a whole wave of
 * verdicts. It has cost a full live gate run twice, on 2026-08-13 and again on 2026-08-14.
 *
 * WHY THE DETECTOR MOVED HERE. R31 built the diagnosis against `NO_RESULT_FOR_METHOD`, which only
 * `bcdev_test_run` produces. The tables gate runs its baseline through the FENCED RunMutant
 * transport, which answers differently, so the detector never fired on the path that hit the
 * problem either time. Both sentinels now live in this module, and both producers import them from
 * here, so a producer cannot reword its literal without the detector following.
 *
 * WHY THE SERVER'S WORDS AND NOT THE CLIENT'S LINE COUNT. `RunOneMethod`
 * (extensions/lethal-control/src/RunMethod.Codeunit.al) answers `{"error": "expected exactly one
 * method %1, found %2"}` with no `testResults` key, and `BuildRunError` (ControlApi.Codeunit.al)
 * wraps EVERY caught phase-2 terminal error in that same shape. So "zero test lines" reaches the
 * client for a missing method, for a DUPLICATE method, for a lock timeout on the suite tables, and
 * for a failed suite load alike. Keying on the line count would name a confident wrong cause on all
 * of those, and a wrong named cause is worse than the silence it replaces: the operator republishes
 * an app that was never stale, the transient clears on the retry, and the wrong diagnosis looks
 * confirmed. `, found 0` has exactly one producing code path (RunMethod.Codeunit.al, `MatchCount`
 * of 0), and a wholly missing test codeunit lands there too, with the same correct remedy.
 *
 * WHAT IT IS AND IS NOT. Unlike the R35 permissions diagnosis and the R69 TestPage diagnosis, which
 * annotate a failure and let the run continue, this one REFUSES the session (see
 * `StaleTestAppError`). The difference is what the condition does to the numbers: a refused or
 * unrunnable test costs its own coverage, while a test the published app does not contain means the
 * run is measuring a different suite from the one the source describes, and every figure downstream
 * is about a suite nobody can reconstruct.
 */

/**
 * The `bcdev_test_run` producer's sentinel, defined here and re-exported by `bcdev-backend.ts` for
 * its existing callers. Exact equality, never a substring: this is the client's own wording for
 * "the server returned no result for the method we asked about", and a substring rule over text
 * this generic would claim unrelated failures.
 */
export const NO_RESULT_FOR_METHOD = "bcdev_test_run returned no result for the requested method";

/**
 * The AL wording, kept verbatim next to the matcher that reads it. `RunMethod.Codeunit.al` builds
 * it with `StrSubstNo('expected exactly one method %1, found %2', RunTestMethod, MatchCount)`; only
 * the `MatchCount = 0` case means the published app lacks the method.
 */
const AL_MISSING_METHOD_PREFIX = "expected exactly one method ";
const AL_FOUND_NONE_SUFFIX = ", found 0";

/** Separates the transport's own statement from the server's, so both survive intact. */
const SERVER_TEXT_SEPARATOR = "; server: ";

/**
 * The transport's statement about the line count, on its own. Split out so the matcher below builds
 * its prefix from the SAME pieces the producer uses rather than from a second typed copy: a
 * detector matching a string literal its producer might later reword is a silent regression, which
 * is the hazard `NO_RESULT_FOR_METHOD`'s own history records.
 */
const LINE_COUNT_STATEMENT_HEAD = "RunMutant returned ";
const LINE_COUNT_STATEMENT_TAIL = " test lines, expected exactly 1";

function lineCountStatement(lineCount: number): string {
  return `${LINE_COUNT_STATEMENT_HEAD}${lineCount}${LINE_COUNT_STATEMENT_TAIL}`;
}

/**
 * The failure message for a RunMutant answer that did not carry exactly one test line.
 *
 * `serverError` is the `error` key of the server's `codeunitResults`, which is `unknown` because it
 * comes straight out of `JSON.parse`. The three cases are deliberate:
 *
 * - **Absent, or an empty string**: the message is byte-identical to what this branch produced
 *   before R139. `{"testResults":[]}` with no `error` key is a distinct, unmeasured server state,
 *   and annotating it would invent a diagnosis for something nobody has measured.
 * - **A non-empty string**: appended verbatim. This is the whole point: the server already says
 *   precisely what went wrong and the transport used to discard it.
 * - **Present but not a string**: an explicit malformation note carrying truncated evidence. NEVER
 *   `String(...)`, which would render `{"error":{...}}` as `[object Object]`, exactly the plausible
 *   default this repo's conventions forbid. It does not throw either: a malformed SERVER answer is
 *   not a caller-contract violation, and the transport's precedent for those is a mapped error
 *   verdict that carries its evidence.
 */
export function runMutantLineCountMessage(lineCount: number, serverError: unknown): string {
  const base = lineCountStatement(lineCount);
  if (serverError === undefined || serverError === null) return base;
  if (typeof serverError === "string") {
    return serverError === "" ? base : `${base}${SERVER_TEXT_SEPARATOR}${serverError}`;
  }
  let rendered: string;
  try {
    rendered = JSON.stringify(serverError) ?? "(unserializable)";
  } catch {
    rendered = "(unserializable)";
  }
  return `${base}; server error key present but not a string: ${rendered.slice(0, 200)}`;
}

/**
 * The only shape that means "the published test app does not contain this method": the transport's
 * zero-line statement, the server's own missing-method wording, and a `MatchCount` of 0.
 *
 * Matched with string operations rather than a regex on purpose. Both ends are anchored by
 * construction, there is nothing to escape, and AL permits quoted procedure names containing commas
 * and spaces, which a lazy or unanchored pattern would truncate.
 */
const MISSING_METHOD_PREFIX = `${lineCountStatement(0)}${SERVER_TEXT_SEPARATOR}${AL_MISSING_METHOD_PREFIX}`;

/**
 * True when a failure message came from the transport's line-count branch at all.
 *
 * Exported because the OTHER baseline classifiers need it. Surfacing the server's text made
 * previously-discarded BC wording visible to `describeTestPermissionsRefusal` and
 * `describeTestPageUnsupported`, so a phase-2 permission failure on the SUITE tables would now
 * match R35's rule and hand the operator R35's remedy ("your test codeunit most likely omits
 * `TestPermissions = Disabled`"), which is the wrong fix for a suite-management refusal. This prefix
 * proves the test body never executed, so any permission or TestPage wording inside such a message
 * is about suite management, not about the test.
 */
export function isRunMutantLineCountMessage(failureText: string | undefined): boolean {
  if (failureText === undefined) return false;
  // Any line count, not just zero: a two-line answer is a different fault but it is equally not a
  // statement about the test body, so the same reasoning applies.
  return (
    failureText.startsWith(LINE_COUNT_STATEMENT_HEAD) &&
    failureText.includes(LINE_COUNT_STATEMENT_TAIL)
  );
}

/**
 * Names the cause when a baseline test the local source declares is missing from the published test
 * app. Returns `undefined` for every other failure, which is the safe direction: an unclassified
 * error stays exactly as informative as it is today, while a wrong classification actively misleads.
 */
export function describeStaleTestApp(failureText: string | undefined): string | undefined {
  if (failureText === undefined) return undefined;
  if (failureText === NO_RESULT_FOR_METHOD) {
    return "the server returned no result for this test, which means the published test app does not contain it";
  }
  if (!failureText.startsWith(MISSING_METHOD_PREFIX)) return undefined;
  if (!failureText.endsWith(AL_FOUND_NONE_SUFFIX)) return undefined;
  const method = failureText.slice(
    MISSING_METHOD_PREFIX.length,
    failureText.length - AL_FOUND_NONE_SUFFIX.length,
  );
  if (method === "") return undefined;
  return `the published test app does not contain ${method}, which this project's source declares`;
}

/**
 * What to DO about it, in one place so the error and any future report text cannot drift into two
 * accounts of one fact.
 *
 * The symbol-cache step is not padding: the trap that produced this row twice included a stale
 * BUILD of the target sitting in the test project's `.alpackages` under an unchanged version
 * string, so recompiling the test app alone would have reproduced the failure.
 */
export const STALE_TEST_APP_REMEDY =
  "Publishing the test app is the operator's own workflow: LethAL deploys only the instrumented " +
  "target. Recompile the target into the test project's .alpackages (a stale build can hide behind " +
  "an unchanged version string), compile the test project, publish the resulting .app, and verify " +
  "the container reports the version your test project's app.json declares. Then re-run.";

/** One missing test: its qualified name, and the server's own account of why it is missing. */
export interface StaleTestAppFinding {
  readonly name: string;
  readonly description: string;
}

/**
 * Refuses the session rather than measuring a suite the run cannot reconstruct.
 *
 * Extends `Error` DIRECTLY, never another typed error class: bisection reads `AlcCompileError` and
 * nothing else as "this subset does not compile", and a typed-error hierarchy is how that
 * separation gets lost.
 *
 * Thrown after the baseline batch's own event is emitted, so the store rows and the event stream
 * still record what was observed. It does mean `buildReport` never runs, so this message is the
 * ONLY diagnosis the operator gets: it has to name every missing test and the full remedy.
 */
export class StaleTestAppError extends Error {
  readonly missingTests: readonly string[];

  constructor(missing: readonly StaleTestAppFinding[]) {
    const sorted = [...missing].sort((a, b) => a.name.localeCompare(b.name));
    const names = sorted.map((m) => m.name);
    const refusal =
      "Refusing to measure: every mutant covered only by these would be recorded no-coverage and " +
      "the run would report a plausible score for a suite that never ran.";
    // Each test's own line carries the SERVER's claim, not just this detector's conclusion. The
    // repo already keeps BC's verbatim words next to the R35 diagnosis for the same reason: a
    // reader can only overrule a matcher if the evidence travels with it. It also distinguishes
    // which producer answered, since the two arms word their answers differently.
    const evidence = sorted.map((m) => `  ${m.name}: ${m.description}`).join("\n");
    super(
      `the published test app is missing ${names.length} test(s) this project's source declares:\n${evidence}\n${refusal} ${STALE_TEST_APP_REMEDY}`,
    );
    this.name = "StaleTestAppError";
    this.missingTests = names;
  }
}
