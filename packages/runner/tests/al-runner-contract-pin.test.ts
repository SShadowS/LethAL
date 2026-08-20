import { describe, expect, test } from "bun:test";
import { runAlRunnerContractProbe } from "../src/al-runner-contract";

/**
 * R149 — the probe must measure the argv the MUTANTS run under.
 *
 * `contractSummary`'s own promise is that "a run records the contract its verdicts were produced
 * under", and R147 made that half false: every per-mutant invocation carries `--package-cache <pin>`
 * and no `--auto-provision`, while the probe ran before provisioning and therefore unpinned.
 *
 * These drive the probe with a fake spawn and inspect the argv it BUILDS, which is the only thing
 * that distinguishes the two cases — the facts it reports are identical either way.
 */
const spawnCapturing = (seen: string[][]) => async (argv: readonly string[]) => {
  seen.push([...argv]);
  return { exitCode: 1, stdout: "", stderr: "" };
};

describe("the contract probe measures the argv it is given (R149)", () => {
  test("sends --auto-provision when NOT pinned, which is the pre-session shape", async () => {
    const seen: string[][] = [];
    const result = await runAlRunnerContractProbe("al-runner.exe", spawnCapturing(seen), 5_000);
    const withBundles = seen.filter((a) => a.includes("--auto-provision"));
    expect(withBundles.length).toBeGreaterThan(0);
    expect(seen.some((a) => a.includes("--package-cache"))).toBe(false);
    expect(result.measuredProvisioning).toBe("auto-provision");
  });

  test("sends --package-cache <pin> and NO --auto-provision when pinned", async () => {
    // The whole point. The two flags are mutually exclusive in `buildAlRunnerArgv`, so a pinned
    // probe must show the pin and must not keep paying for provisioning.
    const seen: string[][] = [];
    const result = await runAlRunnerContractProbe(
      "al-runner.exe",
      spawnCapturing(seen),
      5_000,
      "C:/cache/28.0/platform-apps",
    );
    const pinned = seen.filter((a) => a.includes("--package-cache"));
    expect(pinned.length).toBeGreaterThan(0);
    expect(pinned.some((a) => a.includes("C:/cache/28.0/platform-apps"))).toBe(true);
    expect(seen.some((a) => a.includes("--auto-provision"))).toBe(false);
    expect(result.measuredProvisioning).toBe("package-cache");
  });

  test("the unknown-flag probe carries NO provisioning flag either way", async () => {
    // R149 called this one of the two facts measured under the wrong argv. It is not: its argv is
    // the binary plus the impossible flag and nothing else, so R147 never touched it. Recorded as a
    // test so the row's correction cannot quietly drift back.
    const seen: string[][] = [];
    await runAlRunnerContractProbe("al-runner.exe", spawnCapturing(seen), 5_000, "C:/pin");
    const unknown = seen.find((a) => a.some((x) => x.startsWith("--lethal-wire-contract-probe")));
    expect(unknown).toBeDefined();
    expect(unknown).toHaveLength(2);
  });
});
