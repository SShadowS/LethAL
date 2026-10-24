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
 * R686: the RunMutant found-0 form alone (`describeStaleTestApp`'s second arm, never
 * `NO_RESULT_FOR_METHOD`). BC's suite discovery listed no such method: the published app lacks it,
 * OR discovery could not list the codeunit's methods (measured on BC 28.4: an `OnRun` that raises).
 */
export function isRunMutantFoundNone(failureText: string | undefined): boolean {
  return (
    failureText !== undefined &&
    failureText !== NO_RESULT_FOR_METHOD &&
    describeStaleTestApp(failureText) !== undefined
  );
}

/** R686: the start of the grouped transport's `suite-unresolved` message; its producer uses it. */
export const GROUP_SUITE_UNRESOLVED_HEAD =
  "RunMutantMany suite-unresolved: the server could not resolve this request's test methods to exactly one function line each, and ran nothing — ";

/**
 * R686: the grouped transport's found-0 form, `RunMany.Codeunit.al`'s `expected exactly one method
 * %1 in codeunit %2, found %3` with %3 = 0, read from the end: AL names may hold spaces and commas.
 * `found 2` and "resolve to the same function line" are other faults and read `undefined`.
 */
export function groupedFoundNone(
  failureText: string | undefined,
): { readonly method: string; readonly codeunitId: number } | undefined {
  if (failureText === undefined || !failureText.startsWith(GROUP_SUITE_UNRESOLVED_HEAD))
    return undefined;
  const reason = failureText.slice(GROUP_SUITE_UNRESOLVED_HEAD.length);
  if (!reason.startsWith(AL_MISSING_METHOD_PREFIX) || !reason.endsWith(AL_FOUND_NONE_SUFFIX))
    return undefined;
  const body = reason.slice(
    AL_MISSING_METHOD_PREFIX.length,
    reason.length - AL_FOUND_NONE_SUFFIX.length,
  );
  const at = body.lastIndexOf(" in codeunit ");
  if (at <= 0) return undefined;
  const codeunitId = Number(body.slice(at + " in codeunit ".length));
  if (!Number.isInteger(codeunitId) || codeunitId <= 0) return undefined;
  return { method: body.slice(0, at), codeunitId };
}

/** R686: what a found-0 answer also means, added to a stale-test-app refusal LethAL cannot narrow. */
export const ONRUN_HINT =
  "If the published app does declare these tests, a test codeunit whose OnRun raises an error gives the same answer: BC runs a test codeunit's OnRun while it builds the suite, and lists none of its methods when that fails.";

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

  /**
   * R462: what the test app's identity, read before the baseline and again at this refusal, says.
   * `unchanged-endpoints`: the same package both times. `identity-unverified`: a read failed, only
   * the test source was hashed, or there was no first read, so the app may be older than the
   * source OR may have been replaced between the two reads.
   */
  constructor(
    missing: readonly StaleTestAppFinding[],
    override readonly cause: "unchanged-endpoints" | "identity-unverified",
    /** R630: why a package read failed, when one did and the server said. */
    unread?: string,
    /** R686: `ONRUN_HINT`, when every finding is the found-0 form LethAL could not narrow. */
    hint?: string,
  ) {
    const { head, names } = missingTestsHead(missing);
    const failed = unread !== undefined ? ` (the read failed: ${unread})` : "";
    const identity =
      cause === "unchanged-endpoints"
        ? "The published test app's package was the same at the start of this batch's baseline and at this refusal; a replace-and-restore between the two reads cannot be ruled out."
        : `LethAL could not compare the published test app's package at the start of this batch's baseline with the one at this refusal${failed}, so the app may be older than the source OR may have been replaced between the two.`;
    super(
      `${head} ${identity} If no other session publishes to this server: ${STALE_TEST_APP_REMEDY}${hint !== undefined ? ` ${hint}` : ""}`,
    );
    this.name = "StaleTestAppError";
    this.missingTests = names;
  }
}

/**
 * R738: BC's run-time answer when a test calls a member its object no longer has, measured on bc2
 * (R-738) for a removed member AND for a changed signature: "Function ID <n> was called. The object
 * with ID <id> does not have a member with that ID." It arises when this run's own altool publish
 * (accepted: altool does not ask BC to recompile installed dependents, R728) removed or re-signed a
 * target member the INSTALLED tests app still calls. Read structurally from the message's FIRST
 * line only (BC's sentence, never the call stack): the object id, then "does not have a member".
 * Returns that id only when it is one of `targetIds` (the target's own declared objects); a member
 * of another app's object is left as an ordinary failure. English text only.
 */
const STALE_MEMBER = /\bThe object with ID (\d+) does not have a member\b/;
export function staleTargetMember(
  failureText: string | undefined,
  targetIds: ReadonlySet<number>,
): number | undefined {
  const first = failureText?.split("\n", 1)[0];
  const m = first === undefined ? null : STALE_MEMBER.exec(first);
  const id = m?.[1] === undefined ? undefined : Number(m[1]);
  return id !== undefined && targetIds.has(id) ? id : undefined;
}

/** R738: one baseline test that failed on a stale target member, and the object BC named. */
export interface StaleTargetMemberFinding {
  readonly name: string;
  readonly objectId: number;
}

/**
 * R738: refuses the session when baseline tests failed because the INSTALLED tests app calls a
 * member of the target that this run's build no longer has (removed, or its signature changed).
 * Without it those tests silently left the green set and every mutant they covered read
 * `no-coverage` (measured: a 100% score). Not a "missing test" (`StaleTestAppError`): the tests
 * exist, they are compiled against an older target. Extends `Error` directly.
 */
export class StaleTargetMemberError extends Error {
  readonly staleTests: readonly string[];

  constructor(findings: readonly StaleTargetMemberFinding[]) {
    const names = findings.map((f) => f.name);
    const objects = [...new Set(findings.map((f) => f.objectId))].join(", ");
    super(
      `${findings.length} baseline test(s) failed because the installed tests app calls a member that this ` +
        `run's target build no longer has (BC: "The object with ID ${objects} does not have a member with that ID"; ` +
        `a removed procedure or a changed signature): ${names.join(", ")}. LethAL refused rather than drop them ` +
        "from the green set, which would score every mutant they cover no-coverage. The tests app on the server " +
        "was compiled against an older target: republish the tests app built against the current target " +
        `source, then re-run. ${STALE_TEST_APP_REMEDY}`,
    );
    this.name = "StaleTargetMemberError";
    this.staleTests = names;
  }
}

/**
 * R462: the published test app's package CHANGED between the read at the start of this batch's
 * baseline and the read at the refusal, so another publish landed in that interval. Extends `Error`
 * directly, for the same reason `StaleTestAppError` does.
 */
export class TestAppChangedError extends Error {
  readonly missingTests: readonly string[];

  constructor(
    missing: readonly StaleTestAppFinding[],
    readonly before: string,
    readonly after: string,
  ) {
    const { head, names } = missingTestsHead(missing);
    super(
      `${head} The published test app's package CHANGED between the start of this batch's baseline and this refusal (${before} at the start, ${after} at the refusal): something published to this server in that interval. Re-run when no other session publishes to it.`,
    );
    this.name = "TestAppChangedError";
    this.missingTests = names;
  }
}

/**
 * R462: which refusal the two identity reads support. Only two `package:` hashes are comparable;
 * anything else (a failed read, a `source:` fallback, no first read) proves nothing either way.
 */
export function testAppRefusal(
  missing: readonly StaleTestAppFinding[],
  before: string | undefined,
  after: string | undefined,
  /** R630: the cause of a read that failed, named in the refusal. */
  unread?: string,
  /** R686: `ONRUN_HINT`, passed to a `StaleTestAppError`. */
  hint?: string,
): StaleTestAppError | TestAppChangedError {
  if (before?.startsWith("package:") && after?.startsWith("package:")) {
    return before === after
      ? new StaleTestAppError(missing, "unchanged-endpoints", undefined, hint)
      : new TestAppChangedError(missing, before, after);
  }
  return new StaleTestAppError(missing, "identity-unverified", unread, hint);
}

/** R686: a found-0 finding, with its test's codeunit and whether it is the RunMutant found-0 form. */
export interface FoundNoneFinding extends StaleTestAppFinding {
  readonly codeunit: string;
  readonly foundNone: boolean;
}

/**
 * R686: BC's suite discovery listed no methods for a test codeunit that the installed test app is
 * PROVEN to compile. Measured on BC 28.4 (R-537): a test codeunit whose `OnRun` raises. Not a stale
 * test app, so it carries no republish remedy. Extends `Error` directly.
 */
export class TestCodeunitDiscoveryError extends Error {
  readonly missingTests: readonly string[];

  constructor(missing: readonly FoundNoneFinding[]) {
    const sorted = [...missing].sort((a, b) => a.name.localeCompare(b.name));
    const codeunits = [...new Set(sorted.map((m) => m.codeunit))];
    const evidence = sorted.map((m) => `  ${m.name}: ${m.description}`).join("\n");
    super(
      `BC's suite discovery listed no methods for test codeunit(s) ${codeunits.map((c) => `"${c}"`).join(", ")}, which the installed test app is proven to compile (the package read before and after the baseline is the proven installed one, and its compiled symbols declare these tests):\n${evidence}\nBC runs a test codeunit's OnRun while it builds the suite, and the measured cause of this answer is an OnRun that raises an error. Open the codeunit in BC's Test Tool to see it. Refusing to measure: every mutant covered only by these tests would be recorded no-coverage.`,
    );
    this.name = "TestCodeunitDiscoveryError";
    this.missingTests = sorted.map((m) => m.name);
  }
}

/**
 * R686: which refusal a baseline's found-0 findings support. `TestCodeunitDiscoveryError` only when
 * every finding is the RunMutant found-0 form, each of their codeunits is found-0 in EVERY in-scope
 * test (an OnRun raise blanks the whole codeunit), the test app is PROVEN installed at the hash read
 * before and after the baseline (a `dev/packages` read alone may serve a published-but-not-installed
 * version), and R403's compiled membership of that package was the session's test-arm evidence.
 * Anything else is `testAppRefusal`, with `ONRUN_HINT` when every finding is the found-0 form.
 */
export function baselineFoundNoneRefusal(a: {
  readonly missing: readonly FoundNoneFinding[];
  /** In-scope baseline tests per codeunit name. */
  readonly testsPerCodeunit: ReadonlyMap<string, number>;
  readonly proven: string | undefined;
  readonly before: string | undefined;
  readonly after: string | undefined;
  readonly compiledInPublishedPackage: boolean;
  readonly unread?: string;
}): StaleTestAppError | TestAppChangedError | TestCodeunitDiscoveryError {
  const allFoundNone = a.missing.length > 0 && a.missing.every((m) => m.foundNone);
  const wholeCodeunits = [...new Set(a.missing.map((m) => m.codeunit))].every(
    (c) => a.missing.filter((m) => m.codeunit === c).length === a.testsPerCodeunit.get(c),
  );
  const provenHere =
    a.proven?.startsWith("package:") === true && a.proven === a.before && a.before === a.after;
  if (allFoundNone && wholeCodeunits && provenHere && a.compiledInPublishedPackage) {
    return new TestCodeunitDiscoveryError(a.missing);
  }
  return testAppRefusal(
    a.missing,
    a.before,
    a.after,
    a.unread,
    allFoundNone ? ONRUN_HINT : undefined,
  );
}

function missingTestsHead(missing: readonly StaleTestAppFinding[]): {
  readonly head: string;
  readonly names: readonly string[];
} {
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
  return {
    head: `the published test app is missing ${names.length} test(s) this project's source declares:\n${evidence}\n${refusal}`,
    names,
  };
}
