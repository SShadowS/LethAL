import { describe, expect, test } from "bun:test";
import {
  type AlRunnerContractResult,
  type ContractFactName,
  contractRefusals,
  runAlRunnerContractProbe,
} from "../src/al-runner-contract";
import { buildAlRunnerArgv } from "../src/al-runner-transport";
import type { SpawnFn } from "../src/publisher";
import { alRunnerStdout } from "./helpers/al-runner-stdout";

/**
 * R123. These tests exist because al-runner publishes several times a day and, during the R93 port,
 * **2.0.1 shipped hours after 2.0.0 and moved the runner-enforced timeout message** from
 * `TIMEOUT after <n>s` back to `Test exceeded <n>s timeout.`. Under the decode as first written that
 * one string turned every hung mutant into a KILL. It was caught by hand; nothing would have caught
 * the next one.
 *
 * Every divergence case below is asserted BY FACT NAME. A single "something refused" assertion
 * cannot tell you which of the five checks is inert, which is precisely how a probe ends up
 * measuring four things and reporting five.
 */

/** The two codeunit ids the probe's own throwaway project uses. Duplicated here rather than
 *  exported: a test that reached into the module for them could not notice the module renaming a
 *  test method out from under its own `--test` filter. */
const TESTS_CODEUNIT = 50011;
const PASSING = `Codeunit${TESTS_CODEUNIT}.ContractProbePasses`;
const HANGING = `Codeunit${TESTS_CODEUNIT}.ContractProbeHangs`;

interface FakeShape {
  readonly versionExit?: number;
  readonly versionText?: string;
  readonly unknownFlagExit?: number;
  readonly passTestName?: string;
  readonly timeoutMessage?: string;
  readonly timeoutStatus?: string;
  /** When true, the broken-target run answers as if it were a clean pass — the false-survivor
   *  direction this fact exists to catch. */
  readonly compileScorable?: boolean;
  /** When set, EVERY spawn rejects with this — the `unmeasurable` path. */
  readonly spawnThrows?: string;
}

/**
 * A fake al-runner reproducing today's MEASURED shapes by default, with one fact overridable at a
 * time. Built from `alRunnerStdout` so the stdout it emits is the real banner-then-JSON shape
 * rather than a bare `JSON.stringify` the binary never produces.
 */
function fakeSpawn(shape: FakeShape = {}): { spawn: SpawnFn; argvs: string[][] } {
  const argvs: string[][] = [];
  const spawn: SpawnFn = async (argv) => {
    argvs.push([...argv]);
    if (shape.spawnThrows !== undefined) throw new Error(shape.spawnThrows);
    if (argv.includes("--version")) {
      return {
        exitCode: shape.versionExit ?? 0,
        stdout: `${shape.versionText ?? "al-runner v2.0.1.0"}\n`,
        stderr: "",
      };
    }
    if (argv.some((a) => a.startsWith("--lethal-wire-contract-probe"))) {
      return {
        exitCode: shape.unknownFlagExit ?? 2,
        stdout: "",
        stderr:
          "Unknown option '--lethal-wire-contract-probe'. Run with --help for the supported flags.\n",
      };
    }
    if (argv.includes(HANGING)) {
      return {
        exitCode: 1,
        stdout: alRunnerStdout({
          tests: [
            {
              name: HANGING,
              status: shape.timeoutStatus ?? "error",
              durationMs: 2019,
              message: shape.timeoutMessage ?? "Test exceeded 2s timeout.",
            },
          ],
          passed: 0,
          failed: 0,
          errors: 1,
          total: 1,
          exitCode: 1,
        }),
        stderr: "",
      };
    }
    // The broken-TARGET run: the probe sends the broken dir as the source bundle beside the real
    // test bundle, which is the shape a live run meets — an instrumented target that fails to
    // compile, a test project that does not. Measured against al-runner v2.0.1.0: exit 1 and
    // COMPLETELY EMPTY stdout. Not exit 3, which is what an all-bundles-broken invocation gives.
    if (argv.some((a) => a.includes("broken"))) {
      return shape.compileScorable === true
        ? {
            // The divergence: a compile failure that comes back looking like a clean run in which
            // nothing failed. Exit 1 is inside the range the decode reads verdicts from, so this
            // is the false-survivor shape exactly.
            exitCode: 1,
            stdout: alRunnerStdout({
              tests: [{ name: PASSING, status: "pass", durationMs: 1 }],
              passed: 1,
              failed: 0,
              errors: 0,
              total: 1,
              exitCode: 1,
            }),
            stderr: "",
          }
        : { exitCode: 1, stdout: "", stderr: "error AL0111: Semicolon expected.\n" };
    }
    return {
      exitCode: 0,
      stdout: alRunnerStdout({
        tests: [{ name: shape.passTestName ?? PASSING, status: "pass", durationMs: 14 }],
        passed: 1,
        failed: 0,
        errors: 0,
        total: 1,
        exitCode: 0,
      }),
      stderr: "",
    };
  };
  return { spawn, argvs };
}

function verdictOf(result: AlRunnerContractResult, fact: ContractFactName): string | undefined {
  return result.facts.find((f) => f.fact === fact)?.verdict;
}

function refusalNames(result: AlRunnerContractResult): ContractFactName[] {
  return result.facts.filter((f) => f.verdict !== "matches").map((f) => f.fact);
}

describe("runAlRunnerContractProbe — today's measured contract MATCHES", () => {
  test("all five facts match against a fake reproducing al-runner v2.0.1.0", async () => {
    const { spawn } = fakeSpawn();
    const result = await runAlRunnerContractProbe("al-runner", spawn);
    // Named individually rather than as a count: a probe that silently stopped emitting one fact
    // would still satisfy "no divergences", which is the empty-vs-empty shape this module exists
    // to refuse.
    expect(verdictOf(result, "version")).toBe("matches");
    expect(verdictOf(result, "unknown-flag-rejected")).toBe("matches");
    expect(verdictOf(result, "qualified-test-name")).toBe("matches");
    expect(verdictOf(result, "timeout-classified")).toBe("matches");
    expect(verdictOf(result, "compile-failure-not-scorable")).toBe("matches");
    expect(contractRefusals(result)).toEqual([]);
  });

  test("the 2.0.0 timeout wording ALSO matches — both measured releases, not just the current one", async () => {
    // 2.0.0.0 said this; 2.0.1.0 says `Test exceeded <n>s timeout.`. Both are in
    // RUNNER_TIMEOUT_MESSAGE, and the probe reads that same regex rather than a copy, so this
    // pins that the union really covers both rather than the regex having quietly narrowed.
    const { spawn } = fakeSpawn({ timeoutMessage: "TIMEOUT after 2s" });
    const result = await runAlRunnerContractProbe("al-runner", spawn);
    expect(verdictOf(result, "timeout-classified")).toBe("matches");
  });

  test("the banner reading is recorded, and its absence is not a refusal", async () => {
    const { spawn } = fakeSpawn();
    const result = await runAlRunnerContractProbe("al-runner", spawn);
    // `alRunnerStdout` always emits a banner, which is 2.0.0.0's shape. 2.0.1.0 emitted none on the
    // paths measured, and `parseAlRunnerPayload` handles both — so this is informational and must
    // never appear in the refusal list.
    expect(result.bannerOnStdout).toBe(true);
    expect(contractRefusals(result)).toEqual([]);
  });
});

describe("runAlRunnerContractProbe — each fact diverges on its own", () => {
  /**
   * THE CASE THE WHOLE ROW EXISTS FOR. A third wording nobody has seen — which is exactly what
   * 2.0.1 was, hours after 2.0.0 — must DIVERGE and refuse, naming the fact and telling the reader
   * to add it to `RUNNER_TIMEOUT_MESSAGE`.
   */
  test("an unrecognised timeout wording diverges, and the refusal says what to do", async () => {
    const { spawn } = fakeSpawn({ timeoutMessage: "test aborted: budget elapsed (2s)" });
    const result = await runAlRunnerContractProbe("al-runner", spawn);
    expect(refusalNames(result)).toEqual(["timeout-classified"]);
    const [refusal] = contractRefusals(result);
    expect(refusal).toContain("timeout-classified");
    expect(refusal).toContain("test aborted: budget elapsed (2s)");
    expect(refusal).toContain("RUNNER_TIMEOUT_MESSAGE");
  });

  /**
   * THE DANGEROUS DIRECTION. If al-runner ever ACCEPTS a flag it does not understand, every flag
   * this adapter sends could be silently dropped — including `--isolation`, which decides whether
   * one test's residue can set the next one's verdict. No other fact here would notice, because
   * every one of them is measured through a command line that would look accepted.
   */
  test("an unknown flag that exits 0 diverges", async () => {
    const { spawn } = fakeSpawn({ unknownFlagExit: 0 });
    const result = await runAlRunnerContractProbe("al-runner", spawn);
    expect(refusalNames(result)).toEqual(["unknown-flag-rejected"]);
    expect(contractRefusals(result)[0]).toContain("silently dropped");
  });

  test("a v1 binary diverges on version", async () => {
    // v1.0.31 rejected `--version` outright: non-zero exit, and this text.
    const { spawn } = fakeSpawn({
      versionExit: 1,
      versionText: "Error: file or directory not found: --version",
    });
    const result = await runAlRunnerContractProbe("al-runner", spawn);
    expect(refusalNames(result)).toEqual(["version"]);
    expect(contractRefusals(result)[0]).toContain("--version");
  });

  test("a changed test-name shape diverges", async () => {
    // The shape that would break the `--test` filter and the result lookup at once.
    const { spawn } = fakeSpawn({ passTestName: "Lethal Contract Tests::ContractProbePasses" });
    const result = await runAlRunnerContractProbe("al-runner", spawn);
    expect(refusalNames(result)).toEqual(["qualified-test-name"]);
    const [refusal] = contractRefusals(result);
    expect(refusal).toContain(PASSING);
    expect(refusal).toContain("Lethal Contract Tests::ContractProbePasses");
  });

  /**
   * The false-survivor direction, and the fact whose FIRST draft was wrong in a way only the real
   * binary showed. It originally pinned `exit 3`, measured from an invocation where every bundle
   * was broken. A real run is not that shape: the instrumented target fails to compile while the
   * test bundle compiles fine, and al-runner v2.0.1.0 answers THAT with exit 1 and empty stdout.
   * Exit 1 is inside the range the decode reads verdicts from, so pinning the exit code would have
   * pinned a case that never happens and missed the one that does.
   */
  test("a compile failure that comes back readable and passing diverges — the false-survivor direction", async () => {
    const { spawn } = fakeSpawn({ compileScorable: true });
    const result = await runAlRunnerContractProbe("al-runner", spawn);
    expect(refusalNames(result)).toEqual(["compile-failure-not-scorable"]);
    expect(contractRefusals(result)[0]).toContain("false SURVIVORS");
  });
});

describe("runAlRunnerContractProbe — unmeasurable refuses, it does not pass", () => {
  /**
   * The distinction this module is built on, and the one place `runAlRunnerCanary` deliberately
   * behaves differently: the canary demotes its own failures to a warning and lets the session go
   * on, which is right for a defect canary. Here "we could not confirm the contract" must not read
   * as "the contract holds" — that is nothing compared to nothing.
   */
  test("a spawn that throws makes every fact unmeasurable AND refuses", async () => {
    const { spawn } = fakeSpawn({ spawnThrows: "ENOENT: al-runner not on PATH" });
    const result = await runAlRunnerContractProbe("al-runner", spawn);
    for (const f of result.facts) {
      expect(f.verdict, `fact ${f.fact}`).toBe("unmeasurable");
    }
    expect(contractRefusals(result).length).toBe(result.facts.length);
    expect(contractRefusals(result)[0]).toContain("UNMEASURABLE");
  });

  test("every fact is still REPORTED when the probe cannot run — a short list would read as a pass", async () => {
    const { spawn } = fakeSpawn({ spawnThrows: "ENOENT" });
    const result = await runAlRunnerContractProbe("al-runner", spawn);
    expect(result.facts.map((f) => f.fact).sort()).toEqual([
      "compile-failure-not-scorable",
      "qualified-test-name",
      "timeout-classified",
      "unknown-flag-rejected",
      "version",
    ]);
  });
});

describe("the probe measures the command line the transport actually sends", () => {
  /**
   * A probe that blesses a command nobody runs measures nothing. Pinned by asserting the probe's
   * own spawned argv EQUALS `buildAlRunnerArgv`'s output for the same request — the transport calls
   * that same function, so this couples the two without duplicating a literal flag list that would
   * have to be kept in step by hand.
   */
  test("the probe's test-run argv is buildAlRunnerArgv's output verbatim", async () => {
    const { spawn, argvs } = fakeSpawn();
    await runAlRunnerContractProbe("al-runner", spawn);
    const passArgv = argvs.find((a) => a.includes(PASSING));
    expect(passArgv).toBeDefined();
    const [, ...rest] = passArgv ?? [];
    const sourceDir = rest.at(-2);
    const testDir = rest.at(-1);
    expect(sourceDir).toBeDefined();
    expect(testDir).toBeDefined();
    expect(passArgv).toEqual(
      buildAlRunnerArgv("al-runner", {
        sourceDir: sourceDir ?? "",
        testDir: testDir ?? "",
        qualifiedTest: PASSING,
      }),
    );
  });

  test("the hang probe carries a per-test budget in the env, not as a flag", async () => {
    // v2 dropped `--test-timeout`; if the probe ever sent it as a flag, al-runner would reject the
    // whole invocation as an unknown option and the timeout fact would go unmeasurable rather than
    // measuring anything.
    const { spawn, argvs } = fakeSpawn();
    await runAlRunnerContractProbe("al-runner", spawn);
    for (const argv of argvs) {
      expect(argv).not.toContain("--test-timeout");
    }
  });
});
