import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AL_RUNNER_V2_VERSION, RUNNER_TIMEOUT_MESSAGE } from "./al-runner-backend";
import { alRunnerEnv, buildAlRunnerArgv, qualifiedTestName } from "./al-runner-transport";
import type { SpawnFn } from "./publisher";
import { defaultSpawn } from "./publisher";

/**
 * ROADMAP R123 — measure al-runner's WIRE CONTRACT against the binary actually installed, once per
 * `--backend al-runner` session, and refuse the session when a fact this adapter's decode depends
 * on has moved.
 *
 * WHY THIS AND NOT THE CANARY. `runAlRunnerCanary` (al-runner-canary.ts) measures two behavioural
 * defects, R7 and R8. al-runner v2 FIXES both, so on any current install it reports
 * "not reproduced" twice and says nothing about the thing that actually changes. And it changes
 * fast: al-runner publishes several times a day, and during the R93 port **2.0.1 shipped hours
 * after 2.0.0 and moved the runner-enforced timeout message** from `TIMEOUT after <n>s` back to
 * `Test exceeded <n>s timeout.`, keeping `status: "error"`. Under the decode as first written that
 * one string turned every hung mutant into a KILL. It was caught by hand. Nothing would have caught
 * the next one.
 *
 * WHY IT DOES NOT GO THROUGH `OneShotTransport`. The transport is the thing whose assumptions are
 * under test. A probe routed through it cannot see an exit code the transport already collapsed
 * into `kind: "error"`, nor a stdout shape `parseAlRunnerPayload` already normalised. So this
 * spawns al-runner directly — but through `buildAlRunnerArgv`/`alRunnerEnv`, the SAME argv and env
 * the transport sends, because a probe that blesses a command line nobody runs measures nothing.
 *
 * THAT SENTENCE IS NOW HALF TRUE, AND THE GAP IS FILED RATHER THAN HIDDEN. R147 made every
 * per-mutant invocation carry `--package-cache <the pinned platform-apps directory>` and drop
 * `--auto-provision`, while this probe still builds its invocations with no pin. It runs from
 * `cli.ts` BEFORE `runSession`, so before any provisioning has happened and therefore before a pin
 * exists — which is why closing it means changing R123's own design rather than adding a field here.
 * See `docs/roadmap/R149.md`. Two of the five facts make it more than bookkeeping:
 * `compile-failure-not-scorable`, which stands between a project that failed to compile and a batch
 * of false survivors, and `unknown-flag-rejected`, whose whole test is the exit code.
 *
 * WHY AN UNMEASURABLE FACT REFUSES. `runAlRunnerCanary` deliberately demotes its own failures to a
 * warning and lets the session proceed; that is right for a defect canary, whose silence is
 * informative in itself and whose absence costs the reader a caveat. It is wrong here. "We could
 * not confirm the contract" is not "the contract holds", and treating the two the same is
 * empty-vs-empty — this project's signature bug, in the one place built to prevent it. The canary's
 * behaviour is deliberately NOT changed.
 *
 * COST. Five facts, four al-runner invocations (the version probe, the unknown-flag probe, one real
 * test run that yields both the name shape and the banner reading, one hang, one broken project),
 * roughly 15-25 s in total on the machine this was measured on. Immaterial against a real mutation
 * run — the same argument the canary makes for its own ~5 s — and NOT immaterial against a
 * single-mutant smoke test, which is why it runs once per session and never per mutant.
 */

/** What a single measured fact came back as. */
export type ContractVerdict = "matches" | "diverged" | "unmeasurable";

/**
 * One fact, its expectation, and what was actually observed.
 *
 * `expected` and `measured` are both recorded, and both are printed on a refusal, because "the
 * contract moved" is useless to whoever has to fix it. What they need is which of the two strings
 * changed and into what.
 */
export interface ContractFact {
  /** Stable machine key — the thing a reader greps for. Never reworded. */
  readonly fact: ContractFactName;
  readonly verdict: ContractVerdict;
  readonly expected: string;
  readonly measured: string;
  /** What this adapter would get WRONG if this fact has moved and nobody noticed. */
  readonly consequence: string;
}

/**
 * The closed set of facts measured. A named union rather than free strings so
 * `CONTRACT_FACT_CONSEQUENCES`'s `Record<>` below makes adding a fact a compile error until its
 * consequence is written — the same device `MutantErrorCause`/`ERROR_CAUSE_INTERPRETATIONS` uses in
 * report.ts, and for the same reason: a fact nobody can interpret is a fact nobody will act on.
 */
export type ContractFactName =
  | "version"
  | "unknown-flag-rejected"
  | "qualified-test-name"
  | "timeout-classified"
  | "compile-failure-not-scorable";

/**
 * What this adapter gets wrong if each fact has moved. Written once, here, so a refusal message and
 * a roadmap row cannot drift apart.
 */
export const CONTRACT_FACT_CONSEQUENCES: Record<ContractFactName, string> = {
  version:
    "This adapter sends v2-only flags (--isolation/--test/--package-cache, positional bundle " +
    "dirs). A v1 binary rejects every one of them, and an unknown binary is not something to " +
    "score a project against.",
  "unknown-flag-rejected":
    "If al-runner stops REJECTING flags it does not understand, every flag this adapter sends " +
    "could be silently dropped — including --isolation, which decides whether one test's residue " +
    "can set the next one's verdict. Nothing else in this probe would notice, because every other " +
    "fact is measured through a command line that would look accepted.",
  "qualified-test-name":
    "The same name is used to FILTER (--test) and to LOOK UP the result. A shape change breaks " +
    "both at once: the filter selects nothing, or the lookup misses and every mutant is recorded " +
    "`error` with 'output has no test named ...'.",
  "timeout-classified":
    "A runner-enforced timeout stops being recognised, so a hung mutant is no longer " +
    "`timeout-killed`. The fail-closed rule in AlRunnerBackend.run keeps that from becoming a " +
    "false KILL — it records `error` instead — but the mutant silently leaves the score's " +
    "denominator, and the run reports a different number than it should. Fix by adding the new " +
    "wording to RUNNER_TIMEOUT_MESSAGE.",
  "compile-failure-not-scorable":
    "A target that does not compile must never come back looking like a clean run in which no " +
    "test failed. That would be a whole batch of false SURVIVORS — the worst outcome this tool " +
    "has, because it reads as good news. Stated as a PROPERTY rather than as an exit code on " +
    "purpose: measured 2026-08-07, al-runner answers this shape with exit 1 and completely EMPTY " +
    "stdout, not the exit 3 an all-bundles-broken invocation gives, so pinning `exit 3` would have " +
    "pinned a case a real run never meets.",
};

export interface AlRunnerContractResult {
  readonly facts: readonly ContractFact[];
  /**
   * The provisioning flag the probe's own invocations carried, DERIVED from the argv it built
   * rather than asserted. R149.
   *
   * `contractSummary` calls itself "one line stating what was measured … so a run records the
   * contract its verdicts were produced under". R147 made that half false: every per-mutant
   * invocation now carries `--package-cache <pin>` and no `--auto-provision`, while this probe still
   * builds its invocations with no pin, because it runs from `cli.ts` BEFORE `runSession` and
   * therefore before a pin exists. So the contract is measured under one argv and the verdicts come
   * from another, differing by exactly the flag R147 changed.
   *
   * Closing that properly means changing R123's own design — moving the probe after provisioning,
   * giving it a throwaway provisioning, or adding a second pinned measurement — which R149 records
   * and this does not attempt. What this does is stop the two being silently conflated: the summary
   * now SAYS which argv it measured, so a reader comparing the contract line against a verdict can
   * see the difference instead of assuming there is none.
   *
   * Derived so it cannot rot: if R123 ever gains a pin, this follows the argv rather than needing a
   * second edit somewhere else.
   */
  readonly measuredProvisioning: "auto-provision" | "package-cache";
  /**
   * Whether stdout carried a progress banner ahead of the JSON envelope. INFORMATIONAL — no
   * refusal. `parseAlRunnerPayload` handles both, and the two releases measured disagreed:
   * 2.0.0.0 emitted one, 2.0.1.0 did not on the paths probed. Recorded because a reader debugging
   * a parse problem wants to know which shape their binary produces, not because anything breaks.
   */
  readonly bannerOnStdout: boolean;
}

/** A flag that can never be real, so a non-zero exit proves the runner still refuses what it does
 *  not understand. Named after this project so an operator meeting it in a log knows who sent it. */
const IMPOSSIBLE_FLAG = "--lethal-wire-contract-probe";

/** Small on purpose: the hang probe costs this many seconds of wall clock, and 2 is enough for
 *  al-runner's own timer to fire (measured: a 2 s budget produced `Test exceeded 2s timeout.`). */
const HANG_TIMEOUT_SECONDS = 2;

/** Generous relative to the ~5-8 s a cold al-runner invocation measured at — the probe must not
 *  itself become the reason a slower machine cannot start a session. */
const PROBE_DEADLINE_MS = 120_000;

const CONTRACT_APP_ID = "b2f4c6a8-1d3e-4f5a-8b9c-0d1e2f3a4b5c";
const CONTRACT_TESTS_APP_ID = "c3e5d7b9-2f4a-4b6c-9d8e-1f2a3b4c5d6e";
const CONTRACT_APP_CODEUNIT_ID = 50010;
const CONTRACT_TESTS_CODEUNIT_ID = 50011;

/** The test whose name shape is read back, and whose run supplies the banner reading. */
const PASSING_METHOD = "ContractProbePasses";
/** The test the runner is expected to time out. */
const HANGING_METHOD = "ContractProbeHangs";

function appJson(id: string, name: string, dependsOn?: { id: string; name: string }): string {
  return JSON.stringify(
    {
      id,
      name,
      publisher: "LethAL",
      version: "1.0.0.0",
      dependencies:
        dependsOn === undefined
          ? []
          : [{ id: dependsOn.id, name: dependsOn.name, publisher: "LethAL", version: "1.0.0.0" }],
      idRanges: [{ from: 50000, to: 50099 }],
      resourceExposurePolicy: {
        allowDebugging: true,
        allowDownloadingSource: true,
        includeSourceInSymbolFile: true,
      },
      runtime: "13.0",
    },
    null,
    2,
  );
}

/**
 * A loop large enough that no machine finishes it inside the probe's budget. Deliberately pure
 * arithmetic: nothing here touches the database, so a timeout measured against it is al-runner's
 * own timer firing rather than a slow query or a lock.
 */
const CONTRACT_APP_AL = `codeunit ${CONTRACT_APP_CODEUNIT_ID} "Lethal Contract Probe"
{
    procedure Spin()
    var
        I: Integer;
        Acc: Decimal;
    begin
        for I := 1 to 2000000000 do
            Acc += I;
    end;
}
`;

const CONTRACT_TESTS_AL = `codeunit ${CONTRACT_TESTS_CODEUNIT_ID} "Lethal Contract Tests"
{
    Subtype = Test;

    var
        Probe: Codeunit "Lethal Contract Probe";

    [Test]
    procedure ${PASSING_METHOD}()
    begin
    end;

    [Test]
    procedure ${HANGING_METHOD}()
    begin
        Probe.Spin();
    end;
}
`;

/** Deliberately un-compilable. The point is only that `alc` refuses it, so the shape of the
 *  nonsense does not matter — it must simply never become valid AL. */
const BROKEN_AL = `codeunit ${CONTRACT_APP_CODEUNIT_ID} "Lethal Contract Probe"
{
    procedure Spin()
    begin
        this is not valid AL at all ;;;
    end;
}
`;

interface ProbeDirs {
  readonly appDir: string;
  readonly testDir: string;
  readonly brokenDir: string;
}

async function writeProbeProject(root: string): Promise<ProbeDirs> {
  const appDir = join(root, "app");
  const testDir = join(root, "tests");
  const brokenDir = join(root, "broken");
  for (const d of [join(appDir, "src"), join(testDir, "src"), join(brokenDir, "src")]) {
    await mkdir(d, { recursive: true });
  }
  await writeFile(join(appDir, "app.json"), appJson(CONTRACT_APP_ID, "Lethal Contract Probe"));
  await writeFile(join(appDir, "src", "Probe.Codeunit.al"), CONTRACT_APP_AL, "utf8");
  await writeFile(
    join(testDir, "app.json"),
    appJson(CONTRACT_TESTS_APP_ID, "Lethal Contract Tests", {
      id: CONTRACT_APP_ID,
      name: "Lethal Contract Probe",
    }),
  );
  await writeFile(join(testDir, "src", "Tests.Codeunit.al"), CONTRACT_TESTS_AL, "utf8");
  await writeFile(join(brokenDir, "app.json"), appJson(CONTRACT_APP_ID, "Lethal Contract Probe"));
  await writeFile(join(brokenDir, "src", "Broken.Codeunit.al"), BROKEN_AL, "utf8");
  return { appDir, testDir, brokenDir };
}

/**
 * Finds the `--output-json` envelope the same way `parseAlRunnerPayload` does, and reports whether
 * anything preceded it. Duplicated rather than shared on purpose: this function's job is to
 * describe what the RUNNER emitted, and reusing the parser would make the reading a statement about
 * the parser instead. The two are pinned against the same measured stdout shape by tests.
 */
function readEnvelope(stdout: string): { json: unknown; banner: boolean } | undefined {
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if ((lines[i] ?? "").startsWith("{")) {
      try {
        return {
          json: JSON.parse(lines.slice(i).join("\n")),
          banner: lines.slice(0, i).some((l) => l.trim() !== ""),
        };
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function testsOf(json: unknown): Array<{ name?: unknown; status?: unknown; message?: unknown }> {
  const tests =
    typeof json === "object" && json !== null ? (json as { tests?: unknown }).tests : undefined;
  return Array.isArray(tests) ? tests : [];
}

function fact(
  name: ContractFactName,
  verdict: ContractVerdict,
  expected: string,
  measured: string,
): ContractFact {
  return {
    fact: name,
    verdict,
    expected,
    measured,
    consequence: CONTRACT_FACT_CONSEQUENCES[name],
  };
}

/**
 * Measures the contract. NEVER throws: every failure — a spawn that rejects, a scratch directory
 * that cannot be written, output that cannot be read — becomes an `unmeasurable` fact carrying the
 * real error text. Refusing is `contractRefusals`' job, and keeping the two apart is what lets a
 * test drive a divergence without also having to drive an exception.
 */
export async function runAlRunnerContractProbe(
  alRunnerPath: string,
  spawn: SpawnFn = defaultSpawn,
  deadlineMs: number = PROBE_DEADLINE_MS,
): Promise<AlRunnerContractResult> {
  const facts: ContractFact[] = [];
  let bannerOnStdout = false;
  /**
   * R149. DERIVED from the argv this probe actually built, on the first invocation that builds one,
   * rather than hardcoded to the value that is true today. If R123 ever gains a pin, this follows.
   */
  let measuredProvisioning: AlRunnerContractResult["measuredProvisioning"] = "auto-provision";
  let root: string | undefined;

  /**
   * One probe invocation, bounded — by a RACE, not by catching a rejection.
   *
   * The first draft aborted an `AbortController` and relied on `spawn` rejecting. It does not.
   * MEASURED: `defaultSpawn` given an aborted signal RESOLVES, after the kill, with
   * `exitCode: 143` (128 + SIGTERM) and whatever partial stdout the child had written. So the
   * `catch` never ran and the deadline message was dead code — and worse, a killed process was
   * handed to the facts below as an ordinary answer. `unknown-flag-rejected` checks only
   * "non-zero exit", so a probe that TIMED OUT scored `matches`: "the runner rejected our flag",
   * concluded from a process that never answered. That is the one fact whose entire job is to make
   * the argv trustworthy, passing for the wrong reason.
   *
   * Racing the way `OneShotTransport.send` already does makes the deadline an explicit outcome
   * instead of an exception nobody throws.
   */
  const run = async (
    argv: readonly string[],
    env?: Record<string, string>,
  ): Promise<{ exitCode: number; stdout: string; stderr: string } | { error: string }> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const res = await Promise.race([
        spawn(argv, {
          signal: controller.signal,
          ...(env !== undefined ? { env } : {}),
        }),
        new Promise<"deadline">((resolve) => {
          timer = setTimeout(() => {
            controller.abort();
            resolve("deadline");
          }, deadlineMs);
        }),
      ]);
      return res === "deadline"
        ? { error: `the probe exceeded its own ${deadlineMs} ms deadline and was aborted` }
        : res;
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(timer);
    }
  };

  /**
   * Whether an exit code is one the CHILD chose, rather than one a signal imposed on it.
   *
   * Same measurement as above: a killed child comes back as 128 + signal (143 for SIGTERM), and a
   * spawn failure can surface as a negative code. Neither is al-runner answering. This matters for
   * exactly one fact — `unknown-flag-rejected`, whose whole test is "did the exit code say no?" —
   * because every other fact reads the OUTPUT and therefore fails to read anything when the process
   * was killed. Belt-and-braces beside the race above, and cheap: the two would have to fail
   * together for a killed process to be scored as an answer again.
   */
  const isChildChosenExit = (exitCode: number): boolean => exitCode >= 0 && exitCode < 128;

  // 1. version
  const ver = await run([alRunnerPath, "--version"]);
  if ("error" in ver) {
    facts.push(fact("version", "unmeasurable", "exit 0 matching /\\bv2\\.\\d/", ver.error));
  } else {
    const line = (ver.stdout.trim() || ver.stderr.trim()).split("\n")[0] ?? "";
    facts.push(
      fact(
        "version",
        ver.exitCode === 0 && AL_RUNNER_V2_VERSION.test(line) ? "matches" : "diverged",
        "exit 0 matching /\\bv2\\.\\d/",
        `exit ${ver.exitCode}: ${JSON.stringify(line)}`,
      ),
    );
  }

  // 2. an unknown flag is still REJECTED
  const unknown = await run([alRunnerPath, IMPOSSIBLE_FLAG]);
  if ("error" in unknown) {
    facts.push(fact("unknown-flag-rejected", "unmeasurable", "a non-zero exit", unknown.error));
  } else if (!isChildChosenExit(unknown.exitCode)) {
    // A signal killed it, so the runner never said anything about the flag. `unmeasurable`, which
    // refuses — NOT `matches`, which is what "non-zero means rejected" concluded from exit 143.
    facts.push(
      fact(
        "unknown-flag-rejected",
        "unmeasurable",
        "a non-zero exit chosen by the process (measured: 2)",
        `exit ${unknown.exitCode}, which is a signal kill or a spawn failure rather than an answer`,
      ),
    );
  } else {
    facts.push(
      fact(
        "unknown-flag-rejected",
        unknown.exitCode !== 0 ? "matches" : "diverged",
        "a non-zero exit chosen by the process (measured: 2)",
        `exit ${unknown.exitCode}`,
      ),
    );
  }

  try {
    root = await mkdtemp(join(tmpdir(), "lethal-alrunner-contract-"));
    const dirs = await writeProbeProject(root);
    const wantedName = qualifiedTestName(CONTRACT_TESTS_CODEUNIT_ID, PASSING_METHOD);

    // 3. the qualified test-name shape, plus the banner reading, from one real run
    const passArgv = buildAlRunnerArgv(alRunnerPath, {
      sourceDir: dirs.appDir,
      testDir: dirs.testDir,
      qualifiedTest: wantedName,
    });
    // R149: read the provisioning flag off the argv this probe is about to SEND, so the summary
    // reports what was measured rather than what someone believed at writing time. `buildAlRunnerArgv`
    // makes the pin and `--auto-provision` mutually exclusive, so one of the two is always present.
    measuredProvisioning = passArgv.includes("--package-cache")
      ? "package-cache"
      : "auto-provision";
    const passRun = await run(passArgv, alRunnerEnv(HANG_TIMEOUT_SECONDS));
    if ("error" in passRun) {
      facts.push(fact("qualified-test-name", "unmeasurable", wantedName, passRun.error));
    } else {
      const env = readEnvelope(passRun.stdout);
      if (env === undefined) {
        facts.push(
          fact(
            "qualified-test-name",
            "unmeasurable",
            wantedName,
            `no readable --output-json envelope (exit ${passRun.exitCode})`,
          ),
        );
      } else {
        bannerOnStdout = env.banner;
        const names = testsOf(env.json).map((t) => String(t.name));
        facts.push(
          fact(
            "qualified-test-name",
            names.includes(wantedName) ? "matches" : "diverged",
            wantedName,
            names.length > 0 ? names.join(", ") : "<no tests in envelope>",
          ),
        );
      }
    }

    // 4. a runner-enforced timeout is still classifiable
    const hangName = qualifiedTestName(CONTRACT_TESTS_CODEUNIT_ID, HANGING_METHOD);
    const hangRun = await run(
      buildAlRunnerArgv(alRunnerPath, {
        sourceDir: dirs.appDir,
        testDir: dirs.testDir,
        qualifiedTest: hangName,
      }),
      alRunnerEnv(HANG_TIMEOUT_SECONDS),
    );
    if ("error" in hangRun) {
      facts.push(
        fact("timeout-classified", "unmeasurable", String(RUNNER_TIMEOUT_MESSAGE), hangRun.error),
      );
    } else {
      const env = readEnvelope(hangRun.stdout);
      const t = env === undefined ? undefined : testsOf(env.json).find((x) => x.name === hangName);
      const message = t === undefined ? undefined : t.message;
      if (typeof message !== "string") {
        facts.push(
          fact(
            "timeout-classified",
            "unmeasurable",
            String(RUNNER_TIMEOUT_MESSAGE),
            `the hang probe returned no message (exit ${hangRun.exitCode}, status ${JSON.stringify(t?.status ?? "<no test>")})`,
          ),
        );
      } else {
        facts.push(
          fact(
            "timeout-classified",
            RUNNER_TIMEOUT_MESSAGE.test(message) ? "matches" : "diverged",
            String(RUNNER_TIMEOUT_MESSAGE),
            `status ${JSON.stringify(t?.status)}, message ${JSON.stringify(message)}`,
          ),
        );
      }
    }

    // 5. a target that does not compile cannot be mistaken for a clean run
    //
    // The bundle pair here is deliberate and was corrected by measurement. Sending the broken dir
    // as BOTH positional arguments — the obvious way to write this — makes al-runner v2.0.1.0 die
    // with an unhandled `System.ArgumentException: An item with the same key has already been
    // added` out of its own `Reporter.SerializeJsonOutput`, because the two bundles share a
    // basename. That is an upstream defect (see R124) and, more to the point, it is not the shape
    // a real run meets. A real run has an instrumented TARGET that fails to compile beside a test
    // bundle that compiles fine, which is what this sends.
    //
    // And the answer to that shape is NOT exit 3, which is what an all-bundles-broken invocation
    // gives: measured 2026-08-07 it is exit 1 with completely EMPTY stdout. Exit 1 is inside the
    // range the decode reads verdicts from, so the only thing standing between that and a batch of
    // false survivors is `parseAlRunnerPayload` REFUSING an unreadable envelope instead of
    // returning `[]`. This fact measures that property directly rather than pinning either exit
    // code, because the exit code turned out to be the wrong thing to pin.
    const brokenRun = await run(
      buildAlRunnerArgv(alRunnerPath, {
        sourceDir: dirs.brokenDir,
        testDir: dirs.testDir,
        qualifiedTest: wantedName,
      }),
      alRunnerEnv(HANG_TIMEOUT_SECONDS),
    );
    const expectation =
      "a compile failure must not yield a readable envelope naming the requested test";
    if ("error" in brokenRun) {
      facts.push(
        fact("compile-failure-not-scorable", "unmeasurable", expectation, brokenRun.error),
      );
    } else {
      const env = readEnvelope(brokenRun.stdout);
      const scorable =
        (brokenRun.exitCode === 0 || brokenRun.exitCode === 1) &&
        env !== undefined &&
        testsOf(env.json).some((t) => t.name === wantedName);
      facts.push(
        fact(
          "compile-failure-not-scorable",
          scorable ? "diverged" : "matches",
          expectation,
          `exit ${brokenRun.exitCode}, ${
            env === undefined
              ? "no readable envelope"
              : `envelope naming ${testsOf(env.json).length} test(s)`
          }`,
        ),
      );
    }
  } catch (err) {
    // Scratch-directory setup failed, so facts 3-5 were never attempted. Record them as
    // unmeasurable rather than omitting them: a result whose `facts` array is short would let a
    // caller that counts matches conclude everything passed.
    const detail = err instanceof Error ? err.message : String(err);
    for (const name of [
      "qualified-test-name",
      "timeout-classified",
      "compile-failure-not-scorable",
    ] as const) {
      if (!facts.some((f) => f.fact === name)) {
        facts.push(fact(name, "unmeasurable", "<not attempted>", detail));
      }
    }
  } finally {
    if (root !== undefined) {
      try {
        // Same Windows EBUSY/EPERM retry as AlRunnerBackend.deploy() and the canary's cleanup: a
        // warm al-runner process, an indexer or an AV scanner can still hold the directory.
        await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch (err) {
        console.warn(
          `[lethal] al-runner contract probe: could not clean up ${root} (harmless): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  return { facts, bannerOnStdout, measuredProvisioning };
}

/**
 * Turns a measured contract into the reasons to refuse the session, or an empty list.
 *
 * Every fact is refuse-class, including `unmeasurable` — see the module doc comment for why "we
 * could not confirm it" must not read as "it holds".
 */
export function contractRefusals(result: AlRunnerContractResult): string[] {
  return result.facts
    .filter((f) => f.verdict !== "matches")
    .map((f) => `${refusalHeader(f)}\n${REFUSAL_FOOTER}`);
}

function refusalHeader(f: ContractFact): string {
  return (
    `[lethal] al-runner wire contract ${f.verdict.toUpperCase()} — ${f.fact}\n` +
    `    expected: ${f.expected}\n` +
    `    measured: ${f.measured}\n` +
    `    consequence: ${f.consequence}`
  );
}

/** Where to look, said once. al-runner ships several times a day, so an upstream release is the
 *  likeliest cause of any divergence and the first move is to re-measure, not to edit code. */
const REFUSAL_FOOTER =
  '    The measured baseline is docs/measurements/README.md §"al-runner v2 — the CLI and wire ' +
  'contract"; this check is ROADMAP R123. al-runner publishes several times a day, so an ' +
  "upstream release is the likeliest cause — re-measure before changing any code.";

/** One line stating what was measured, printed on every al-runner session so a run records the
 *  contract its verdicts were produced under. */
export function contractSummary(result: AlRunnerContractResult): string {
  const version = result.facts.find((f) => f.fact === "version")?.measured ?? "<unknown>";
  const shape = result.facts.map((f) => `${f.fact}=${f.verdict}`).join(" ");
  // R149: the argv is NAMED rather than left implied. This line's own promise is that a run records
  // the contract its verdicts were produced under, and since R147 that is only true when the session
  // did not pin: a pinned session measures the contract under `--auto-provision` and produces its
  // verdicts under `--package-cache <pin>`. Saying which was measured is the difference between a
  // reader who can see that gap and one who assumes there is none.
  return (
    `[lethal] al-runner wire contract: ${version} | ${shape} | banner=${result.bannerOnStdout}` +
    ` | measured-under=--${result.measuredProvisioning}` +
    " (a session that PINS produces its verdicts under --package-cache instead; R149)"
  );
}
