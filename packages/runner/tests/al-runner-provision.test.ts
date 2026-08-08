import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AL_RUNNER_PROVISION_SENTINEL, AlRunnerBackend } from "../src/al-runner-backend";
import type { SpawnFn } from "../src/publisher";

/**
 * R128 — the one-time provisioning step, and the three properties that decide whether it helps or
 * quietly hurts.
 *
 * It exists because `--auto-provision` rides in every mutant's argv, so without it the FIRST
 * invocation of a run does the downloading inside that mutant's timeout budget and the mutant is
 * scored `deadline-exceeded` for an infrastructure reason.
 *
 * MEASURED 2026-08-09 on al-runner 2.1.1.0, and it is what makes this worth building: the download
 * is not a once-per-machine cost. `--auto-provision` resolves the project's BC version by PREFIX to
 * the LATEST matching Microsoft build, so a machine whose cache was warm yesterday is cold as soon
 * as upstream publishes a new one. A run on this machine's fully warm cache still fetched 135 MB.
 */

interface Recorded {
  readonly argv: readonly string[];
  readonly env: Record<string, string> | undefined;
}

function spyingSpawn(result: { exitCode: number; stdout: string; stderr: string }) {
  const calls: Recorded[] = [];
  const spawn: SpawnFn = async (argv, opts) => {
    calls.push({ argv: [...argv], env: opts?.env });
    return result;
  };
  return { calls, spawn };
}

async function makeBackend(spawn: SpawnFn) {
  const dir = await mkdtemp(join(tmpdir(), "lethal-alrunner-provision-"));
  await writeFile(join(dir, "MutationSelector.Codeunit.al"), "placeholder", "utf8");
  return new AlRunnerBackend(
    {
      alRunnerPath: "al-runner",
      instrumentedDir: dir,
      testDir: "/tests",
      packagesDir: "/packages",
      selectorObjectId: 50000,
    },
    spawn,
  );
}

/** The runner's own lines, verbatim from the 2026-08-09 measurement. */
const WARM =
  "[bc] no --bc-version given - selecting BC 28.1.49838.50794, the exact build this binary was compiled against.\n" +
  "[provision] BC 28.1.49838.50794 engine artifacts already complete at C:\\x\\28.1.49838.50794.\n" +
  "[provision] test toolkit already present at C:\\x\\28.1.49838.50794\\test-apps.\n";
const COLD =
  "[provision] Resolving BC version prefix '28.0'...\n" +
  "[provision] Resolved: 28.0 -> 28.0.46665.53508\n" +
  "[provision] fetching Microsoft platform R2R apps for BC 28.0.46665.53508  C:\\x\\28.0.46665.53508\\platform-apps\n" +
  "[provision] Downloaded 6 app(s) (115 MB total) to C:\\x\\28.0.46665.53508\\platform-apps\n";

describe("AlRunnerBackend.provisionOnce (R128)", () => {
  test("sends a real `--auto-provision` invocation, not the `provision` subcommand", () => {
    // Re-measured on 2.1.1.0: the subcommand resolves the platform apps at the PROJECT's version but
    // the TEST TOOLKIT at the BINARY's, so it leaves the directory the run will actually select
    // without a toolkit and the first mutant downloads it anyway. R128's own stated reason — "it
    // fetches no engine artifacts at all" — is wrong; it reports them complete exactly as
    // `--auto-provision` does.
    return (async () => {
      const { calls, spawn } = spyingSpawn({ exitCode: 0, stdout: "", stderr: WARM });
      await (await makeBackend(spawn)).provisionOnce();
      const argv = calls[0]?.argv ?? [];
      expect(argv).toContain("--auto-provision");
      expect(argv).not.toContain("provision");
    })();
  });

  test("selects NO test, so the invocation exists only for its provisioning side effect", async () => {
    const { calls, spawn } = spyingSpawn({ exitCode: 0, stdout: "", stderr: WARM });
    await (await makeBackend(spawn)).provisionOnce();
    const argv = calls[0]?.argv ?? [];
    const filterIndex = argv.indexOf("--test");
    expect(filterIndex).toBeGreaterThanOrEqual(0);
    expect(argv[filterIndex + 1]).toBe(AL_RUNNER_PROVISION_SENTINEL);
  });

  test("reports `downloaded` only when the runner actually fetched something", async () => {
    const warm = spyingSpawn({ exitCode: 0, stdout: "", stderr: WARM });
    expect((await (await makeBackend(warm.spawn)).provisionOnce()).downloaded).toBe(false);

    const cold = spyingSpawn({ exitCode: 0, stdout: "", stderr: COLD });
    expect((await (await makeBackend(cold.spawn)).provisionOnce()).downloaded).toBe(true);
  });

  test("a non-zero exit is not a failure — the invocation runs no test", async () => {
    // Provisioning happens before the runner decides anything about tests, so an exit code that
    // reflects "no test matched" must not read as "provisioning did not happen".
    const { spawn } = spyingSpawn({ exitCode: 1, stdout: "", stderr: COLD });
    const result = await (await makeBackend(spawn)).provisionOnce();
    expect(result.ran).toBe(true);
    expect(result.downloaded).toBe(true);
  });

  test("is BOUNDED — an abort signal is handed to the spawn", async () => {
    // Without a deadline this step would MOVE an unbounded hang rather than remove one: a wedged
    // al-runner inside a mutant is bounded by that mutant's `deadlineMs`, while a wedged one here
    // would hang the session before the lease is even taken — a worse failure mode than the one
    // being fixed.
    //
    // What is asserted is the MECHANISM, not the 30-minute budget: waiting for the real deadline is
    // not a test anyone would run, and shortening it for the test would pin a number this code does
    // not otherwise expose. A spawn given no signal cannot be aborted at all, so this is the
    // property whose absence would silently restore the unbounded wait.
    let sawSignal = false;
    const spawn: SpawnFn = async (_argv, opts) => {
      sawSignal = opts?.signal instanceof AbortSignal;
      return { exitCode: 0, stdout: "", stderr: WARM };
    };
    await (await makeBackend(spawn)).provisionOnce();
    expect(sawSignal).toBe(true);
  });

  test("a spawn failure is reported, never thrown — this can only ever be best-effort", async () => {
    // If provisioning cannot run, the session must proceed exactly as it did before this existed:
    // the first mutant pays the download. Throwing here would turn an optimisation into a new way to
    // lose a run.
    const spawn: SpawnFn = async () => {
      throw new Error("ENOENT: al-runner");
    };
    const result = await (await makeBackend(spawn)).provisionOnce();
    expect(result.ran).toBe(false);
    expect(result.detail).toContain("ENOENT");
  });

  test("uses the TEST bundle, which exists at session start when the instrumented dir does not", async () => {
    const { calls, spawn } = spyingSpawn({ exitCode: 0, stdout: "", stderr: WARM });
    await (await makeBackend(spawn)).provisionOnce();
    const argv = calls[0]?.argv ?? [];
    expect(argv).toContain("/tests");
    // ONCE, not twice. Bundle dirs are positional and repeatable, and this invocation passes the
    // test dir as both source and test — sending it twice would compile the same bundle twice for
    // nothing, which on a real project is a whole extra compile before the session starts.
    expect(argv.filter((a) => a === "/tests").length).toBe(1);
    // And the package cache, or symbol resolution differs from what every later invocation uses.
    expect(argv).toContain("--package-cache");
    expect(argv).toContain("/packages");
  });
});
