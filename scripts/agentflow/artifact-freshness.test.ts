import { describe, expect, test } from "bun:test";
import {
  type ExpectedApp,
  type LedgerEntry,
  type ObservedApp,
  classifyFreshness,
  freshnessProblems,
} from "./artifact-freshness.ts";

const SRC_A = "sha256:aaaa";
const SRC_B = "sha256:bbbb";

const expected: ExpectedApp[] = [
  { app: "LethAL Sandbox Data", version: "1.0.0.9", sourceHash: SRC_A },
  { app: "LethAL Sandbox Data Tests", version: "1.0.0.17", sourceHash: SRC_B },
];

const ledger: LedgerEntry[] = [
  { app: "LethAL Sandbox Data", sourceHash: SRC_A, version: "1.0.0.9", packageId: "pkg-1" },
  { app: "LethAL Sandbox Data Tests", sourceHash: SRC_B, version: "1.0.0.17", packageId: "pkg-2" },
];

const observed: ObservedApp[] = [
  { app: "LethAL Sandbox Data", version: "1.0.0.9", packageId: "pkg-1" },
  { app: "LethAL Sandbox Data Tests", version: "1.0.0.17", packageId: "pkg-2" },
];

describe("everything published from the current source", () => {
  test("is fresh", () => {
    const r = classifyFreshness(expected, ledger, observed);
    expect(r.every((x) => x.verdict === "fresh")).toBe(true);
    expect(freshnessProblems(r)).toEqual([]);
  });
});

describe("R56, the failure where nothing moves", () => {
  test("source changed with NO version bump and the app was never republished", () => {
    // The exact shape: app.json is untouched, so the server's version still equals what candidate
    // source claims. A version comparison agrees with itself while describing different code.
    const changed: ExpectedApp[] = [
      expected[0] as ExpectedApp,
      { app: "LethAL Sandbox Data Tests", version: "1.0.0.17", sourceHash: "sha256:NEW" },
    ];
    const r = classifyFreshness(changed, ledger, observed);

    const tests = r.find((x) => x.app === "LethAL Sandbox Data Tests");
    expect(tests?.verdict).toBe("stale");

    // And the version really is identical on both sides, which is why this check exists.
    expect(changed[1]?.version).toBe(observed[1]?.version as string);

    const problems = freshnessProblems(r);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("nobody can reproduce");
    expect(problems[0]).toContain("R56");
  });

  test("a version bump with no republish is caught too", () => {
    const bumped: ExpectedApp[] = [
      expected[0] as ExpectedApp,
      { app: "LethAL Sandbox Data Tests", version: "1.0.0.18", sourceHash: "sha256:NEW" },
    ];
    expect(
      classifyFreshness(bumped, ledger, observed).find((x) => x.app === "LethAL Sandbox Data Tests")
        ?.verdict,
    ).toBe("stale");
  });
});

describe("a publish nobody recorded", () => {
  test("is unverified, not fresh", () => {
    // The door R56 came in: someone publishing the test app by hand as their own workflow. The
    // executor cannot say what source went into it, so it must not vouch for it.
    const handPublished: ObservedApp[] = [
      observed[0] as ObservedApp,
      { app: "LethAL Sandbox Data Tests", version: "1.0.0.17", packageId: "pkg-by-hand" },
    ];
    const r = classifyFreshness(expected, ledger, handPublished);
    const tests = r.find((x) => x.app === "LethAL Sandbox Data Tests");
    expect(tests?.verdict).toBe("unverified-publish");
    expect(freshnessProblems(r)[0]).toContain("Republish it through the executor");
  });

  test("an empty ledger makes everything unverified rather than everything fresh", () => {
    // The direction matters. With no record at all the honest answer is "I cannot tell", and the
    // dangerous default would be to treat silence as agreement.
    const r = classifyFreshness(expected, [], observed);
    expect(r.every((x) => x.verdict === "unverified-publish")).toBe(true);
  });
});

describe("both directions are walked", () => {
  test("an app the source builds and the server lacks is missing", () => {
    const r = classifyFreshness(expected, ledger, [observed[0] as ObservedApp]);
    expect(r.find((x) => x.app === "LethAL Sandbox Data Tests")?.verdict).toBe("missing");
  });

  test("a leftover the server has and the source does not build is reported", () => {
    // Not harmless: at most one instrumented target may be installed per container, and a leftover
    // is what trips an attestation mismatch on a run nobody can otherwise explain.
    const withLeftover: ObservedApp[] = [
      ...observed,
      { app: "LethAL Old Fixture", version: "1.0.0.1", packageId: "pkg-old" },
    ];
    const r = classifyFreshness(expected, ledger, withLeftover);
    expect(r.find((x) => x.app === "LethAL Old Fixture")?.verdict).toBe("unexpected");
  });
});

describe("the ledger keyed by package, not by app", () => {
  test("an older entry for the same app does not make a newer package fresh", () => {
    // A package id identifies one publish. Looking up by APP would let the most recent record
    // vouch for a package it never described.
    const twoPublishes: LedgerEntry[] = [
      {
        app: "LethAL Sandbox Data Tests",
        sourceHash: "sha256:OLD",
        version: "1.0.0.17",
        packageId: "pkg-old",
      },
      ...ledger,
    ];
    const runningOld: ObservedApp[] = [
      observed[0] as ObservedApp,
      { app: "LethAL Sandbox Data Tests", version: "1.0.0.17", packageId: "pkg-old" },
    ];
    const r = classifyFreshness(expected, twoPublishes, runningOld);
    expect(r.find((x) => x.app === "LethAL Sandbox Data Tests")?.verdict).toBe("stale");
  });

  test("republishing the same source makes it fresh again", () => {
    const republished: LedgerEntry[] = [
      ...ledger,
      {
        app: "LethAL Sandbox Data Tests",
        sourceHash: SRC_B,
        version: "1.0.0.17",
        packageId: "pkg-3",
      },
    ];
    const now: ObservedApp[] = [
      observed[0] as ObservedApp,
      { app: "LethAL Sandbox Data Tests", version: "1.0.0.17", packageId: "pkg-3" },
    ];
    expect(classifyFreshness(expected, republished, now).every((x) => x.verdict === "fresh")).toBe(
      true,
    );
  });
});

describe("results are ordered so two runs read the same", () => {
  test("by app name", () => {
    const r = classifyFreshness(expected, ledger, [...observed].reverse());
    expect(r.map((x) => x.app)).toEqual(["LethAL Sandbox Data", "LethAL Sandbox Data Tests"]);
  });
});
