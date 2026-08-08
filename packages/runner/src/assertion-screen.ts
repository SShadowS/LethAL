/**
 * R121 — a SCREEN over kills, and deliberately not a classifier.
 *
 * WHAT THE CORPUS SAYS. R85's rung 2 deployed the whole `swap-call-arguments` population on Continia
 * Document Output and produced 73 kills, each carrying its `killingTestFailure` and each classified
 * BY HAND before any rule was written (`docs/campaign/2026-08-08-r85-swap-population/`).
 * `scripts/r121-classify-eval.ts` scores rules against it. Measured 2026-08-08:
 *
 *   | rule                                                        | precision | recall |
 *   | top frame inside the target app (R86's)                     |     30.0% |   100% |
 *   | top frame's procedure is NOT the mutated procedure (R121's) |        0% |     0% |
 *   | no `Assert.` prefix                                         |     26.1% |   100% |
 *   | both halves of R121's own candidate rule                    |        0% |     0% |
 *   | top frame's procedure IS the mutated procedure              |     50.0% |   100% |
 *   | the field-length message text                               |      100% |   100% |
 *
 * **Nothing there is shippable as a classifier.** The best structural rule is a coin flip, and the
 * only perfect one is a message TEXT that is perfect by construction (it IS the ground-truth
 * definition) and English-only by construction (R66).
 *
 * WHAT IS SHIPPABLE. The `Assert.` prefix rule at 100% RECALL. It never misses a false kill, so it
 * supports exactly one honest statement: *"N of your M kills were not produced by a test assertion;
 * read them"* — a count and an instruction, with no claim that any particular one is false. At 26.1%
 * precision on the one corpus that exists, three of every four flagged kills are real. That number
 * is printed, not hidden.
 *
 * THE SCREEN'S OWN LIMITATION, measured rather than assumed, and the reason this reports its own
 * discrimination instead of only a count:
 *
 *   - It depends on the target suite's ASSERTION STYLE. Document Output calls Microsoft's Library
 *     Assert ~1,886 times, so the prefix means something there. All 22 tests in
 *     `fixtures/sandbox-data-tests` raise via bare `Error(...)`, so on the tables gate the screen
 *     flags EVERY kill and separates nothing. A screen that is informative on one suite and vacuous
 *     on another must say which it is doing, or the same number reads as a finding in both cases.
 *   - It depends on the EXECUTION PATH's message shape. The corpus was produced through bcdev. On
 *     the al-runner path a plain `Error()` surfaces as `NavNCLDialogException: <message>` (R101(f)),
 *     so an exception-type prefix sits where the assertion prefix would be and the rule's behaviour
 *     there is unmeasured.
 *
 * THE ONE NON-LOCALISING SIGNAL ANYONE HAS FOUND. R101(f) measured al-runner emitting
 * `InvalidOperationException: out-of-scope: <api> - <category> - see docs/scope.md#<anchor>` when its
 * own guard refuses an API. That marker comes from the runner, in a fixed structural form, not from
 * BC's localised message table — which is exactly the property every other candidate here lacks
 * (R66). It is al-runner-only and bcdev is the authoritative backend, so it does not solve this
 * problem; it is counted as a named subset of the flagged kills rather than left on the floor.
 *
 * PER R72's DISCIPLINE: nothing here moves a verdict. A killed mutant stays killed and stays in
 * `mutationScore`.
 */

/**
 * The message half of a `killingTestFailure`.
 *
 * The field is the message, then `\n`, then the AL callstack (`failureTextOf`,
 * run-mutant-transport.ts). Splitting on the first newline is the only structure there is, and it is
 * the same split `scripts/r121-classify-eval.ts` scored the rule with — that script imports this
 * function rather than carrying its own copy, so the rule that ships and the rule that was measured
 * cannot drift into two spellings.
 */
export function killMessageOf(killingTestFailure: string | undefined): string {
  return (killingTestFailure ?? "").split("\n")[0]?.trim() ?? "";
}

/**
 * Did a test's own assertion produce this failure?
 *
 * `Assert.` is Microsoft's Library Assert, whose failures all begin with the member that failed
 * (`Assert.AreEqual failed`, `Assert.IsTrue failed`, ...). Case-insensitive because AL is.
 *
 * A `false` here is NOT "this kill is false". It is "no assertion prefix was found", which on a
 * suite that raises via bare `Error(...)` is true of every kill.
 */
export function looksLikeAssertionFailure(message: string): boolean {
  return /^Assert\./i.test(message);
}

/**
 * al-runner's own out-of-scope refusal, measured verbatim (R101(f)):
 *
 *     InvalidOperationException: out-of-scope: HttpClient.Get - external-http - see docs/scope.md#external-http
 *
 * Anchored on the `out-of-scope: ` prefix, which R101 identified as the stable machine-readable part
 * — the API name, the category and the anchor all vary. NOT anchored on the exception type: R101's
 * own row named an exception (`RunnerOutOfScopeException`) that does not exist, and pinning a second
 * literal that was never the load-bearing one would repeat that.
 *
 * DOES NOT cover BC's file-sandbox refusal, which R101 measured as a DIFFERENT mechanism
 * (`NavNCLInvalidPathException: Files outside of the current users folder cannot be accessed`) —
 * that one is BC prose and localises. Conflating the two is the mistake R101's own list made.
 */
export function looksLikeRunnerRefusal(message: string): boolean {
  return /\bout-of-scope:\s/.test(message);
}

/** `SessionReport.assertionScreen.diagnosis`, stated once. */
export const ASSERTION_SCREEN_DIAGNOSIS =
  "This is a SCREEN, not a classification, and no verdict moved: every mutant below is still " +
  "`killed` and still in `mutationScore`. What it says is only that no test assertion produced the " +
  "failure text — on the one real corpus this rule has been scored against (73 hand-classified " +
  "kills on a third-party app) it caught every false kill and about three of every four it flagged " +
  "were real kills, where the mutated program errored on its own wrong behaviour. Read them; do not " +
  "subtract them.";

/**
 * What the screen managed to distinguish on THIS run — the field that stops one number reading the
 * same in two very different situations.
 *
 * `vacuous` — every kill carrying text was flagged. The suite does not use an assertion library this
 * rule can see (all 22 tests in `fixtures/sandbox-data-tests` raise via bare `Error(...)`), so the
 * screen separated nothing and its count is not a finding.
 * `partial` — some kills were flagged and some were not. The rule is doing work here.
 * `none` — nothing was flagged: every kill carrying text came from an assertion.
 * `no-text` — no kill carried failure text at all, so the rule was never applied to anything. A
 * separate state rather than folded into `none`, which would read as "every kill came from an
 * assertion" when nothing was examined — the empty-vs-empty confusion this repo is named for.
 */
export type AssertionScreenDiscrimination = "vacuous" | "partial" | "none" | "no-text";

export const ASSERTION_SCREEN_DISCRIMINATION_NOTES: Record<AssertionScreenDiscrimination, string> =
  {
    vacuous:
      "EVERY kill carrying failure text was flagged, so this screen separated nothing on this suite. " +
      "That is a property of the suite's assertion style, not of the mutants: a suite that raises via " +
      "bare `Error(...)` has no assertion prefix for the rule to find. Treat the count as 'not " +
      "measured here', not as a finding.",
    partial:
      "Some kills were flagged and some were not, so the rule discriminated on this suite. Flagged " +
      "kills are the ones to read; the rule catches every false kill it has been scored against and " +
      "flags roughly three real kills for each false one.",
    none: "No kill was flagged: every kill carrying failure text came from a test assertion.",
    "no-text":
      "No kill carried any failure text, so this rule was never applied. That is a statement about " +
      "what the backend reported, not about the kills: it is what a backend that returns no failure " +
      "message produces, and it must not be read as 'every kill came from an assertion'.",
  };
