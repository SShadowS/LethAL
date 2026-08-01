/**
 * R69 §3.1 — the two-gate router for fence-refused TestPage tests.
 *
 * WHY TWO GATES. `describeTestPageUnsupported` (imported below, not reimplemented) was calibrated
 * as a DIAGNOSIS: it matches `CreateNavTestService()` anywhere in a failure's message + stack trace,
 * so a false positive there costs only a mislabel. Promoting that same match into a ROUTING decision
 * raises the stakes — a false positive would route a test onto a path it does not belong on and
 * report it as "opens a TestPage" when it does not. GATE 2 bounds that damage: a test is only routed
 * once it has ALSO been shown to pass, unmutated, on the client-services path (`gate2Passed`, a live
 * call in production, an injected predicate here). Gate 1 alone would build a green set out of tests
 * that never demonstrably pass anywhere; both gates together mean a wrong LABEL is possible, but a
 * wrong VERDICT is not — the classic "survived on no evidence" failure this project treats as its
 * signature bug.
 *
 * `gate1Evidence` carries the diagnosis string verbatim (BC's own quoted refusal text included) so a
 * human reader can inspect and, if warranted, overrule the routing decision — the same escape hatch
 * R35's note gives for its own regex match.
 */

import { describeTestPageUnsupported } from "./testpage-unsupported";

export interface RoutedTest {
  codeunitName: string;
  method: string;
  gate1Evidence: string;
}

export function selectRoutedTests(
  baseline: readonly { codeunitName: string; method: string; failureMessage?: string }[],
  gate2Passed: (t: { codeunitName: string; method: string }) => boolean,
): readonly RoutedTest[] {
  const routed: RoutedTest[] = [];
  for (const entry of baseline) {
    const { codeunitName, method, failureMessage } = entry;
    const gate1Evidence = describeTestPageUnsupported(failureMessage);
    if (gate1Evidence === undefined) continue;
    if (!gate2Passed({ codeunitName, method })) continue;
    routed.push({ codeunitName, method, gate1Evidence });
  }
  return routed;
}
