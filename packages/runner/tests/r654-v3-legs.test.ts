// R654 S2 (plan docs/superpowers/plans/2026-10-22-r654-retire-dotnet-alrunner.md §S2; pre-commitment
// docs/superpowers/specs/2026-10-22-r654-v3-gate-legs-precommitment.md, 43115c78): the pure halves of
// the new `itest:alrunner-v3` legs. K (the CLI's own defaults) is OUT of `V3_GATE_LEGS` by the
// orchestrator's ruling, under two conditions pinned here: (1) on a candidate build K is skipped
// with a stated summary, never silently; (2) on a gated build a K that is not a pass FAILS the
// itest, a skip included, so K can never become an always-skipped leg.
import { describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { V3_GATE_LEGS, gateOutcome } from "../itest/al-runner-v3-gate";
import {
  V3_AGENTFLOW_LEGS,
  V3_K_CANDIDATE_SKIP,
  isSessionTestCall,
  judgeLegK,
  legKSection,
  v3DefaultLegs,
  v3ItestFailures,
  v3KOnCandidate,
  v3RecordRunFailures,
} from "../itest/alrunner-v3-legs";
import {
  AL_RUNNER_V3_NOT_AUTHORITATIVE,
  validateAlRunnerV3Config,
} from "../src/al-runner-v3-config";
import { buildBackend } from "../src/cli";
import { buildFakeAppWithEntries } from "./helpers/fake-app";

const BC = "28.0.46665.47126";

describe("R654 S2: the leg sets", () => {
  test("L1, Y-A and Y-B are update-gate legs; K is not", () => {
    for (const l of ["L1", "Y-A", "Y-B"]) expect(V3_GATE_LEGS as readonly string[]).toContain(l);
    expect(V3_GATE_LEGS as readonly string[]).not.toContain("K");
  });

  test("the default legs: K always listed (it runs, or is skipped with its summary); D and T only when configured", () => {
    // R602 (flipped on purpose): MO and WR join the default set, after Y-B, and (orchestrator
    // ruling) V3_GATE_LEGS too, so the update gate judges them.
    expect(v3DefaultLegs({ cdo: false, tables: false })).toEqual([
      "C",
      "S1",
      "S1E", // R761: also in V3_GATE_LEGS (alpha.2 reads pass, not applicable)
      "S3",
      "N1",
      "N1E", // R722: also in V3_GATE_LEGS (alpha.2 reads pass, not applicable)
      "N1S", // R763: also in V3_GATE_LEGS (alpha.2 reads pass, not applicable)
      "O1", // R784: also in V3_GATE_LEGS (alpha.2 reads pass, not applicable)
      "X",
      "L1",
      "Y-A",
      "Y-B",
      "MO",
      "WR",
      "K",
    ]);
    expect(v3DefaultLegs({ cdo: true, tables: true })).toEqual([
      "C",
      "S1",
      "S1E",
      "S3",
      "N1",
      "N1E",
      "N1S",
      "O1",
      "X",
      "L1",
      "Y-A",
      "Y-B",
      "MO",
      "WR",
      "K",
      "D1",
      "D1c",
      "T",
    ]);
  });

  test("agentflow's exact list is the default set with no corpus and no tables leg", () => {
    expect([...V3_AGENTFLOW_LEGS]).toEqual(v3DefaultLegs({ cdo: false, tables: false }));
  });
});

describe("R654 S2, condition (2): K fails the itest on a gated build", () => {
  const allPass = (extra: Record<string, string> = {}) => ({
    ...Object.fromEntries(v3DefaultLegs({ cdo: false, tables: false }).map((l) => [l, "pass"])),
    ...extra,
  });

  const DEFAULT = v3DefaultLegs({ cdo: false, tables: false });

  test("gated: every leg passing is no failure", () => {
    expect(v3ItestFailures(allPass(), false, DEFAULT)).toEqual([]);
  });

  test("gated: a K mismatch (gate-fail) fails the itest, though the update-gate outcome ignores K", () => {
    const legs = allPass({ K: "gate-fail" });
    expect(v3ItestFailures(legs, false, DEFAULT)).toEqual(["K=gate-fail"]);
    // The update gate's receipt outcome is judged on V3_GATE_LEGS alone (K is outside it).
    expect(gateOutcome(legs as never)).not.toBe("gate-fail");
  });

  test("gated: K skipped with the candidate summary is still a failure (never an always-skipped leg)", () => {
    expect(v3ItestFailures(allPass({ K: V3_K_CANDIDATE_SKIP }), false, DEFAULT)).toEqual([
      `K=${V3_K_CANDIDATE_SKIP}`,
    ]);
  });

  test("gated: K selected but missing from the legs is a failure", () => {
    const { K: _k, ...noK } = allPass();
    expect(v3ItestFailures(noK, false, DEFAULT)).toEqual(["K=missing"]);
  });

  test("a selection without K (LETHAL_ITEST_V3_LEGS=T, a record run) is not judged on K", () => {
    expect(v3ItestFailures({ T: "pass" }, false, ["T"])).toEqual([]);
    expect(v3ItestFailures({ T: "pass" }, true, ["T"])).toEqual([]);
  });
});

describe("R654 S2, condition (1): on a candidate K is skipped with its summary, never silently", () => {
  const SELECTED = v3DefaultLegs({ cdo: true, tables: true });
  const candidateLegs = (k: string | undefined) => ({
    ...Object.fromEntries(V3_GATE_LEGS.map((l) => [l, "pass"])),
    ...(k !== undefined ? { K: k } : {}),
  });

  test("the summary value is exactly 'skipped (candidate build)'", () => {
    expect(V3_K_CANDIDATE_SKIP).toBe("skipped (candidate build)");
  });

  test("candidate: K with the summary is no itest failure", () => {
    expect(v3ItestFailures(candidateLegs(V3_K_CANDIDATE_SKIP), true, SELECTED)).toEqual([]);
  });

  test("candidate: K absent from the summary is a failure (a silent skip)", () => {
    expect(v3ItestFailures(candidateLegs(undefined), true, SELECTED)).toEqual(["K=missing"]);
  });

  test("candidate: any other skip wording, or another leg with that summary, is a failure", () => {
    expect(v3ItestFailures(candidateLegs("skipped"), true, SELECTED)).toEqual(["K=skipped"]);
    expect(
      v3ItestFailures(
        { ...candidateLegs(V3_K_CANDIDATE_SKIP), L1: V3_K_CANDIDATE_SKIP },
        true,
        SELECTED,
      ),
    ).toEqual([`L1=${V3_K_CANDIDATE_SKIP}`]);
  });
});

describe("build review M2: a run in which no leg passed is never a PASS", () => {
  test("a candidate run of K alone (K skipped, nothing measured) fails with a named reason", () => {
    expect(v3ItestFailures({ K: V3_K_CANDIDATE_SKIP }, true, ["K"])).toEqual(["no leg passed"]);
  });

  test("an empty run fails the same way", () => {
    expect(v3ItestFailures({}, false, [])).toEqual(["no leg passed"]);
  });

  test("the other direction: one passed leg beside the candidate's skipped K passes", () => {
    expect(v3ItestFailures({ S1: "pass", K: V3_K_CANDIDATE_SKIP }, true, ["S1", "K"])).toEqual([]);
  });
});

describe("build review M4: a record run exits 3 only when every leg it did not record passed", () => {
  const SEL = ["L1", "Y-A", "Y-B"];

  test("every selected leg recorded: no failure (exit 3, recorded)", () => {
    const legs = { L1: "gate-fail", "Y-A": "gate-fail", "Y-B": "gate-fail" };
    expect(v3RecordRunFailures(legs, new Set(SEL), false, SEL)).toEqual([]);
  });

  test("a leg that failed its table (so recorded nothing) is named (exit 1)", () => {
    const legs = { L1: "gate-fail", "Y-A": "gate-fail", "Y-B": "gate-fail" };
    expect(v3RecordRunFailures(legs, new Set(["L1", "Y-B"]), false, SEL)).toEqual([
      "Y-A=gate-fail",
    ]);
  });

  test("an infra failure beside the recorded legs is named too", () => {
    const legs = { L1: "gate-fail", "Y-A": "infra-fail", "Y-B": "gate-fail" };
    expect(v3RecordRunFailures(legs, new Set(["L1", "Y-B"]), false, SEL)).toEqual([
      "Y-A=infra-fail",
    ]);
  });
});

describe("build review M3: K counts the session's own test calls, not the probes'", () => {
  const TESTS = ["/repo/fixtures/sandbox-tests", "/real/fixtures/sandbox-tests"];
  const call = (testDir: string) => [
    "/bin/al-runner",
    "test",
    "--output-json",
    "--codeunit",
    "79100",
    "--coverage-json",
    "/s/cov.json",
    "/s/backend/active",
    testDir,
  ];

  test("a mutant or baseline call (the session's test folder last) counts, given or resolved", () => {
    expect(isSessionTestCall(call(TESTS[0] ?? ""), TESTS)).toBe(true);
    expect(isSessionTestCall(call(TESTS[1] ?? ""), TESTS)).toBe(true);
  });

  test("a contract-probe or predefined-probe call (its own scratch tests) does not count", () => {
    expect(isSessionTestCall(call("/tmp/lethal-v3-contract-x/tests"), TESTS)).toBe(false);
    expect(isSessionTestCall(["/bin/al-runner", "--version"], TESTS)).toBe(false);
    expect(isSessionTestCall(["/bin/al-runner", "serve", TESTS[0] ?? ""], TESTS)).toBe(false);
  });

  test("R798: the speculative baseline call under a `nice -n 19` prefix still counts; a bare nice does not", () => {
    expect(isSessionTestCall(["/usr/bin/nice", "-n", "19", ...call(TESTS[0] ?? "")], TESTS)).toBe(true);
    expect(isSessionTestCall(["nice", "-n", "19", ...call(TESTS[0] ?? "")], TESTS)).toBe(true);
    expect(isSessionTestCall(["/usr/bin/nice", "-n", "19", "/bin/al-runner", "--version"], TESTS)).toBe(false);
  });
});

describe("R654 S2 leg K: the config it builds from, and what it judges", () => {
  const SECTION_IN = {
    path: "/p/al-runner",
    packagesDir: "/p/deps",
    bcVersion: BC,
    alcPath: "/p/alc",
    cacheDir: "/p/cache",
  };

  test("the section names no coverage and no transport key (the CLI's defaults decide)", () => {
    const s = legKSection(SECTION_IN);
    expect(Object.keys(s).sort()).toEqual([
      "alcPath",
      "bcVersion",
      "cacheDir",
      "packagesDir",
      "path",
    ]);
  });

  const good = {
    coverage: "al-runner",
    // R761: K takes the serve-entries default (pre-commitment master a86927e1).
    inRunStopIsBudget: false,
    serveSpawns: 1,
    oneShotTestCalls: 1,
    warned: true,
    noCoverageFiles: [
      "src/SandboxPricing.Codeunit.al",
      "src/SandboxPricing.Codeunit.al",
      "src/SandboxPricing.Codeunit.al",
      "src/SandboxPricing.Codeunit.al",
    ],
  };

  test("the pre-committed facts judge clean", () => {
    expect(judgeLegK(good)).toEqual([]);
  });

  test("each fact that moves is named", () => {
    expect(judgeLegK({ ...good, coverage: "none" })).toHaveLength(1);
    expect(judgeLegK({ ...good, inRunStopIsBudget: true })).toHaveLength(1);
    expect(judgeLegK({ ...good, serveSpawns: 0 })).toHaveLength(1);
    expect(judgeLegK({ ...good, serveSpawns: 2 })).toHaveLength(1);
    expect(judgeLegK({ ...good, oneShotTestCalls: 0 })).toHaveLength(1);
    expect(judgeLegK({ ...good, oneShotTestCalls: 12 })).toHaveLength(1);
    expect(judgeLegK({ ...good, warned: false })).toHaveLength(1);
    expect(judgeLegK({ ...good, noCoverageFiles: [] })).toHaveLength(1);
    expect(
      judgeLegK({ ...good, noCoverageFiles: [...good.noCoverageFiles.slice(1), "src/Other.al"] }),
    ).toHaveLength(1);
  });
});

describe("R586c: K on a candidate build (an opt-in test seam)", () => {
  const LINUX = process.platform === "linux";
  const section = (dir: string, deps: string) =>
    legKSection({
      path: "/fake/al-runner",
      packagesDir: deps,
      bcVersion: BC,
      alcPath: "/fake/alc",
      cacheDir: join(dir, "cache"),
    });
  async function build(candidate: boolean) {
    const dir = await mkdtemp(join(tmpdir(), "lethal-r586c-k-"));
    try {
      await writeFile(
        join(dir, "app.json"),
        JSON.stringify({
          id: "df1aa9ff-6539-4c86-a9d0-ad702b61ac9a",
          idRanges: [{ from: 79000, to: 79199 }],
          runtime: "17.0",
        }),
      );
      const deps = join(dir, "deps");
      await mkdir(deps);
      await writeFile(
        join(deps, "Microsoft_System Application.app"),
        buildFakeAppWithEntries({
          "NavxManifest.xml": `<?xml version="1.0"?><Package xmlns="http://schemas.microsoft.com/navx/2015/manifest"><App Id="1" Name="System Application" Publisher="Microsoft" Version="${BC}" /></Package>`,
        }),
      );
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        const b = await buildBackend(
          {
            mode: "run",
            projectDir: dir,
            testDir: dir,
            backendKind: "al-runner-v3",
            dbPath: "db",
            configPath: "cfg",
            skipKnownSurvivors: false,
            workers: 1,
            keepEnv: false,
            allowExpiringEnv: false,
          } as Parameters<typeof buildBackend>[0],
          { alRunnerV3: section(dir, deps) },
          dir,
          undefined,
          candidate ? { alRunnerCandidate: true } : {},
          { selectorId: 79199, controlId: 79198, tableId: 79197 },
        );
        return (b as unknown as { cfg: { candidate?: boolean } }).cfg.candidate;
      } finally {
        warn.mockRestore();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test("K-seam-1: the seam builds a backend with candidate: true; without it candidate is absent", async () => {
    if (!LINUX) return;
    expect(await build(true)).toBe(true);
    expect(await build(false)).toBeUndefined();
  });

  test("K-seam-2: nothing a user can write reaches the seam: the config rejects a candidate key", () => {
    expect(() =>
      validateAlRunnerV3Config({
        packagesDir: "/p",
        bcVersion: BC,
        candidate: true,
      }),
    ).toThrow(/unknown key\(s\): candidate/);
  });

  test("K-seam-3: the candidate K-skip tolerance holds unless K was asked to run", () => {
    const legs = { K: V3_K_CANDIDATE_SKIP, C: "pass" };
    expect(v3ItestFailures(legs, true, ["C", "K"])).toEqual([]);
    expect(v3ItestFailures(legs, true, ["C", "K"], false)).toEqual([]);
    expect(v3ItestFailures(legs, true, ["C", "K"], true)).toEqual([`K=${V3_K_CANDIDATE_SKIP}`]);
    expect(v3ItestFailures({ K: "pass", C: "pass" }, true, ["C", "K"], true)).toEqual([]);
  });

  test("K-seam-4: LETHAL_ITEST_V3_K_ON_CANDIDATE takes 1 or unset; anything else is refused by name", () => {
    expect(v3KOnCandidate({})).toBe(false);
    expect(v3KOnCandidate({ LETHAL_ITEST_V3_K_ON_CANDIDATE: "1" })).toBe(true);
    for (const v of ["2", "0", "", "true"])
      expect(() => v3KOnCandidate({ LETHAL_ITEST_V3_K_ON_CANDIDATE: v })).toThrow(
        /al-runner-v3-itest-k-on-candidate-refused/,
      );
  });
});

describe("R654 S2 leg K: buildBackend from that section takes the CLI's defaults", () => {
  // M9: v3 is refused off Linux, so the Windows CI job asserts that refusal instead.
  const LINUX = process.platform === "linux";

  test("coverage on (al-runner), one-shot (in-run stop is the budget), and the not-authoritative warning", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-r654-k-"));
    try {
      await writeFile(
        join(dir, "app.json"),
        JSON.stringify({
          id: "df1aa9ff-6539-4c86-a9d0-ad702b61ac9a",
          idRanges: [{ from: 79000, to: 79199 }],
          runtime: "17.0",
        }),
      );
      const deps = join(dir, "deps");
      await mkdir(deps);
      await writeFile(
        join(deps, "Microsoft_System Application.app"),
        buildFakeAppWithEntries({
          "NavxManifest.xml": `<?xml version="1.0"?><Package xmlns="http://schemas.microsoft.com/navx/2015/manifest"><App Id="1" Name="System Application" Publisher="Microsoft" Version="${BC}" /></Package>`,
        }),
      );
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        const build = buildBackend(
          {
            mode: "run",
            projectDir: dir,
            testDir: dir,
            backendKind: "al-runner-v3",
            dbPath: "db",
            configPath: "cfg",
            skipKnownSurvivors: false,
            workers: 1,
            keepEnv: false,
            allowExpiringEnv: false,
          } as Parameters<typeof buildBackend>[0],
          {
            alRunnerV3: legKSection({
              path: "/fake/al-runner",
              packagesDir: deps,
              bcVersion: BC,
              alcPath: "/fake/alc",
              cacheDir: join(dir, "cache"),
            }),
          },
          dir,
          undefined,
          {},
          { selectorId: 79199, controlId: 79198, tableId: 79197 },
        );
        if (!LINUX) {
          await expect(build).rejects.toThrow(/al-runner-v3-(windows|platform)-unsupported/);
          return;
        }
        const b = await build;
        expect(b.capabilities().coverage).toBe("al-runner");
        expect(b.inRunStopIsBudget).toBe(true);
        expect(warn.mock.calls.map((c) => String(c[0]))).toContain(AL_RUNNER_V3_NOT_AUTHORITATIVE);
      } finally {
        warn.mockRestore();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
