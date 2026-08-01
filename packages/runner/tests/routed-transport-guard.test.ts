import { describe, expect, test } from "bun:test";
import { assertRoutedTransportAllowed } from "../src/orchestrator";

/**
 * R74/R75 GUARD. The client-services routed path is BUILT, unit-tested and red-checked, and it is
 * deliberately NOT WIRED: nothing in production constructs `SessionConfig.routedTransport`. Two
 * filed blockers must close before anything does.
 *
 * R74 is the dangerous one, and it is this project's signature bug wearing a new coat: routed
 * survivors discard the `attested` signal, AND `LC Control State` only sets
 * `ObservedIdentityMismatch` INSIDE the `ObservedAny := true` branch. So the transport's
 * fail-closed `identityMismatch !== false` check passes TRIVIALLY when no guard ever fired —
 * nothing compared to nothing. A routed test that passes without ever reaching the mutated site
 * yields `survived`, counted in the score and excluded from the UNEXERCISED SURVIVORS callout
 * because `guardObserved` is absent rather than `false`. A false survive.
 *
 * The realistic hazard is DRIFT, not the code's existence: a later session wires `routedTransport`
 * without re-reading R74/R75. This guard makes that impossible to do silently — the wiring must
 * name the blockers to proceed, which is this repo's fail-loudly convention applied to its own
 * code. It is a tripwire, not a security boundary: the tests that legitimately exercise the routed
 * path opt in explicitly, and that opt-in is the acknowledgement.
 */
describe("routed transport is fenced off until R74/R75 close", () => {
  test("refuses a routed transport that has not acknowledged the blockers", () => {
    expect(() => assertRoutedTransportAllowed(undefined)).toThrow(/R74/);
  });

  // The message is the whole point of the guard: a reader who trips it must learn WHY without
  // going hunting, so it must EXPLAIN both rows, not merely mention their numbers.
  //
  // Asserts on the substantive content of each blocker rather than on the bare strings "R74"/"R75".
  // A red-check caught the earlier version passing for the wrong reason: the acknowledgement token
  // is itself named `R74/R75-acknowledged`, and the message quotes it, so `toContain("R75")` was
  // satisfied by the token's own name even after the entire R75 explanation was deleted.
  test("explains both blockers and the false-survive they cause", () => {
    let message = "";
    try {
      assertRoutedTransportAllowed(undefined);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    // R74's mechanism and its wrong outcome.
    expect(message).toContain("ObservedIdentityMismatch");
    expect(message).toContain("survived");
    // R75's mechanism — a term that appears nowhere in the ack token.
    expect(message).toContain("coverageAttribution");
  });

  test("allows it when the caller explicitly acknowledges the blockers", () => {
    expect(() => assertRoutedTransportAllowed("R74/R75-acknowledged")).not.toThrow();
  });

  // A wrong token must not pass. Otherwise any truthy value silently disarms the tripwire, which
  // is the same empty-vs-empty shape the guard exists to flag.
  test("refuses an acknowledgement token that is not the exact one", () => {
    expect(() => assertRoutedTransportAllowed("yes")).toThrow(/R74/);
  });
});
