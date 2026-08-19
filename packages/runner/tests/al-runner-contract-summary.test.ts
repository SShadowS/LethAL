import { describe, expect, test } from "bun:test";
import { contractSummary } from "../src/al-runner-contract";
import type { AlRunnerContractResult } from "../src/al-runner-contract";

/**
 * R149. `contractSummary` is the one line printed on every al-runner session, and its own promise is
 * that "a run records the contract its verdicts were produced under".
 *
 * R147 made that half false. Every per-mutant invocation now carries `--package-cache <pin>` and no
 * `--auto-provision`, while the probe still builds its invocations unpinned — it runs from `cli.ts`
 * BEFORE `runSession`, so before a pin exists. The contract is measured under one argv and the
 * verdicts come from another, differing by exactly the flag R147 changed.
 *
 * Closing that means changing R123's own design, which R149 records and does not attempt here. What
 * these tests pin is the cheaper honest step: the line SAYS which argv it measured, so the two can
 * no longer be silently conflated.
 */
const result = (
  measuredProvisioning: AlRunnerContractResult["measuredProvisioning"],
): AlRunnerContractResult => ({
  facts: [
    {
      fact: "version",
      verdict: "matches",
      expected: "v2",
      measured: "al-runner v2.1.2.0",
    } as AlRunnerContractResult["facts"][number],
  ],
  bannerOnStdout: false,
  measuredProvisioning,
});

describe("contractSummary discloses the argv it measured (R149)", () => {
  test("names --auto-provision, which is what the probe sends today", () => {
    const line = contractSummary(result("auto-provision"));
    expect(line).toContain("measured-under=--auto-provision");
  });

  test("warns that a PINNED session produces its verdicts under a different flag", () => {
    // The whole point. Without this clause a reader sees a contract line and a verdict and has no
    // way to know the two came from different command lines.
    expect(contractSummary(result("auto-provision"))).toContain("--package-cache");
    expect(contractSummary(result("auto-provision"))).toContain("R149");
  });

  test("follows the argv rather than a constant, so it cannot rot", () => {
    // If R123 ever gains a pin, the line must say so without a second edit elsewhere. This asserts
    // the value is carried through rather than hardcoded to today's answer.
    expect(contractSummary(result("package-cache"))).toContain("measured-under=--package-cache");
  });

  test("still carries the version and the per-fact shape it always did", () => {
    const line = contractSummary(result("auto-provision"));
    expect(line).toContain("al-runner v2.1.2.0");
    expect(line).toContain("version=matches");
  });
});
