import { describe, expect, test } from "bun:test";
import { bisectFailingMutant } from "../src/bisect";

describe("bisectFailingMutant", () => {
  test("finds and confirms the single offending mutant", async () => {
    const bad = "M0007";
    const outcome = await bisectFailingMutant(
      ["M0001", "M0002", bad, "M0009"],
      async (subset) => !subset.includes(bad),
    );
    expect(outcome).toEqual({ kind: "culprit", culprit: bad });
  });

  test("reports no-repro when everything compiles", async () => {
    expect(await bisectFailingMutant(["M0001", "M0002"], async () => true)).toEqual({
      kind: "no-repro",
    });
  });

  // I3: a failure that reproduces regardless of subset (version monotonicity,
  // transport, licence — observed live, see fixtures/README.md) used to
  // converge on candidates[0] and name an innocent mutant with full
  // confidence. The complement check catches it: the failure still fires with
  // the "culprit" excluded, so no mutant can honestly be blamed.
  test("an environment-caused failure names no mutant (fails on every subset)", async () => {
    const outcome = await bisectFailingMutant(
      ["M0001", "M0002", "M0003", "M0004"],
      async () => false, // deploy broken no matter which mutants are present
    );
    expect(outcome).toEqual({
      kind: "environmental",
      detail: "failure reproduces even with the candidate excluded",
    });
  });

  test("an environment-caused failure names no mutant even with a single candidate", async () => {
    const outcome = await bisectFailingMutant(["M0001"], async () => false);
    expect(outcome).toEqual({
      kind: "environmental",
      detail: "failure reproduces even with the candidate excluded",
    });
  });

  // The other confirmation direction: the search converged on a candidate,
  // but that candidate compiles fine on its own — a transient/order-dependent
  // failure steered the halving, so the "culprit" is unproven and must not be
  // named.
  test("a candidate that compiles alone is not blamed (failure did not reproduce)", async () => {
    const outcome = await bisectFailingMutant(
      ["M0001", "M0002", "M0003", "M0004"],
      async (subset) => subset.length <= 1, // only multi-mutant subsets "fail"
    );
    expect(outcome).toEqual({
      kind: "environmental",
      detail: "narrowed candidate compiles on its own; the failure did not reproduce against it",
    });
  });

  test("an empty candidate set whose bare artifact fails is environmental by definition", async () => {
    const outcome = await bisectFailingMutant([], async () => false);
    expect(outcome).toEqual({
      kind: "environmental",
      detail: "deploy fails with no mutants present",
    });
  });

  test("uses O(log n) compiles, not O(n) — confirmation included", async () => {
    let calls = 0;
    const mutants = Array.from({ length: 64 }, (_, i) => `M${i}`);
    const outcome = await bisectFailingMutant(mutants, async (subset) => {
      calls++;
      return !subset.includes("M63");
    });
    expect(outcome).toEqual({ kind: "culprit", culprit: "M63" });
    expect(calls).toBeLessThan(20);
  });
});
