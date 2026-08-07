import { describe, expect, test } from "bun:test";
import { buildStamp, renderVersion } from "../src/build-info";
import { operatorTiers } from "../src/orchestrator";

/**
 * R88 — a released binary carried no evidence of which commit built it, and the filename could not
 * tell a stale one from a fresh one. Measured 2026-08-04: a local binary was 56 package-commits
 * stale and silently ran a SMALLER operator set than its own source would, with nothing in the
 * report, the filename or `--version` saying so.
 */
describe("renderVersion", () => {
  const stamp = { commit: "a".repeat(40), builtAt: "2026-08-07T09:12:33.000Z", dirty: false };

  test("the FIRST line is exactly the version — `--version | head -1` must keep working", () => {
    const out = renderVersion("1.2.3", ["lethal.empty-block"], stamp);
    expect(out.split("\n")[0]).toBe("1.2.3");
  });

  test("names the commit and the build time", () => {
    const out = renderVersion("1.2.3", ["lethal.empty-block"], stamp);
    expect(out).toContain("a".repeat(40));
    expect(out).toContain("2026-08-07T09:12:33.000Z");
  });

  test("a DIRTY build says the commit does not describe it", () => {
    // The commit alone would be a lie about what is inside, which is worse than no commit at all:
    // a bug report would name a tree that never contained the bug.
    const out = renderVersion("1.2.3", ["lethal.empty-block"], { ...stamp, dirty: true });
    expect(out).toContain("DIRTY");
    expect(out).not.toBe(renderVersion("1.2.3", ["lethal.empty-block"], stamp));
  });

  test("an UNSTAMPED build says so in words rather than omitting the line", () => {
    // A missing line reads as "nothing to say". The honest reading is "this binary cannot tell you
    // what it was built from", and those are different facts.
    const out = renderVersion("1.2.3", ["lethal.empty-block"], undefined);
    expect(out).toContain("built from source; no commit stamp");
  });

  test("lists the operator set, counted and sorted so two binaries diff line-for-line", () => {
    const out = renderVersion("1.2.3", ["lethal.void-method-call", "lethal.empty-block"]);
    expect(out).toContain("operators (2): lethal.empty-block, lethal.void-method-call");
  });

  test("an empty operator set is stated, not silently rendered as a blank list", () => {
    // The 2026-08-04 incident in miniature: the failure mode is a binary running FEWER operators
    // than expected, so "0" has to be readable rather than an empty tail.
    expect(renderVersion("1.2.3", [])).toContain("operators (0):");
  });
});

describe("buildStamp", () => {
  test("is undefined when running from source — the define is not applied under `bun run`", () => {
    // This is what makes the same source runnable both ways: `typeof <undeclared>` is the one
    // expression that does not throw, so a developer build reports "not stamped" instead of
    // crashing on a missing global.
    expect(buildStamp()).toBeUndefined();
  });
});

describe("the operator set `--version` reports", () => {
  test("comes from `operatorTiers`, the SAME map generateMutationSet walks", () => {
    // Not a hand-maintained list. The measured incident was a binary whose operator set differed
    // from its source's; a list maintained beside the real one could drift the same way and report
    // operators the binary cannot run.
    const names = [...operatorTiers.keys()];
    expect(names.length).toBeGreaterThan(5);
    expect(names).toContain("lethal.swap-call-arguments");
    expect(renderVersion("1.2.3", names)).toContain(`operators (${names.length}):`);
  });
});
