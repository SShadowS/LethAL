import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cliDefaultSelectorFailures, testSelectorLineFailures } from "../itest/cli-default-leg";
import {
  AlRunnerBackend,
  TEST_EXACT_PROBE_NAME,
  type TestExactProbeRaw,
  classifyTestExactProbe,
} from "../src/al-runner-backend";
import type { RunEvent } from "../src/events";
import type { SpawnFn } from "../src/publisher";
import { alRunnerStdout } from "./helpers/al-runner-stdout";
import { scratchDirs } from "./helpers/scratch";

const scratch = scratchDirs();

// R551. The probe's raw captures, from /coord/handoff/R-551/captures (scratch paths replaced).
/** c5bbaf89 (has `--test-exact`): exit 6, the `--output-json` envelope on stdout. */
const C5_STDOUT = `{
  "tests": [],
  "passed": 0,
  "failed": 0,
  "errors": 0,
  "skipped": 0,
  "total": 0,
  "exitCode": 6,
  "seed": 983030857,
  "wallSeconds": 1.0680191
}
`;
const C5_STDERR = `al-runner 2.12.0-main.c5bbaf89 · BC 28.5.54151.55132 · 1 app
  [<scratch>/empty] WARN: no app.json under <scratch>/empty — skipping dep loading
[1/1] empty ... SKIP (no suites)
test-selection: --test-exact 'Codeunit0.LethalR551Probe' selected no test in this run. A selection that leaves nothing to run is reported as a failure (exit 6), not as a clean run of 0 tests. --test-exact takes the WHOLE qualified name CodeunitNNNN.Method, case-insensitively, never a substring (the CLR codeunit name carries the object id, not the AL name).
seed: 983030857
`;
/** 43f76177 (no `--test-exact`): exit 2, empty stdout. */
const N43_STDERR = "Unknown option '--test-exact'. Run with --help for the supported flags.\n";

const c5: TestExactProbeRaw = { kind: "exited", exitCode: 6, stdout: C5_STDOUT, stderr: C5_STDERR };
const n43: TestExactProbeRaw = { kind: "exited", exitCode: 2, stdout: "", stderr: N43_STDERR };

const envelope = (over: Record<string, unknown>) =>
  alRunnerStdout({ tests: [], total: 0, exitCode: 6, ...over }, { bundles: 1 });

describe("classifyTestExactProbe (R551)", () => {
  test("P1: c5bbaf89's capture (exit 6, tests [], exitCode 6) is exact", () => {
    expect(classifyTestExactProbe(c5)).toEqual({ kind: "exact" });
  });

  test("P2: 43f76177's capture (exit 2) is substring, naming the exit and the stderr line", () => {
    const r = classifyTestExactProbe(n43);
    expect(r.kind).toBe("substring");
    const reason = r.kind === "substring" ? r.reason : "";
    expect(reason).toContain("exit 2");
    expect(reason).toContain("Unknown option '--test-exact'");
    expect(reason).toBe(
      "exit 2; stderr: Unknown option '--test-exact'. Run with --help for the supported flags.",
    );
  });

  test("P2b: the stderr line skips blank lines and is cut to 200 chars", () => {
    const long = "x".repeat(300);
    const r = classifyTestExactProbe({
      kind: "exited",
      exitCode: 2,
      stdout: "",
      stderr: `\n   \n  ${long}  \nsecond line\n`,
    });
    expect(r).toEqual({ kind: "substring", reason: `exit 2; stderr: ${"x".repeat(200)}` });
  });

  test("P2c: the decision never reads stderr, in either direction", () => {
    for (const stderr of ["", "Unknown option '--test-exact'.", "anything at all", C5_STDERR]) {
      expect(classifyTestExactProbe({ ...c5, stderr } as TestExactProbeRaw).kind).toBe("exact");
      expect(classifyTestExactProbe({ ...n43, stderr } as TestExactProbeRaw).kind).toBe(
        "substring",
      );
    }
  });

  test("P3: exit 0 with an empty-tests envelope is substring", () => {
    const r = classifyTestExactProbe({
      kind: "exited",
      exitCode: 0,
      stdout: envelope({ exitCode: 0 }),
      stderr: "",
    });
    expect(r).toEqual({ kind: "substring", reason: "exit 0" });
  });

  test("P4: exit 6 with empty stdout is substring", () => {
    const r = classifyTestExactProbe({ kind: "exited", exitCode: 6, stdout: "", stderr: "" });
    expect(r).toEqual({ kind: "substring", reason: "exit 6 but no readable envelope" });
  });

  test("P5: exit 6 with one test row is substring", () => {
    const r = classifyTestExactProbe({
      kind: "exited",
      exitCode: 6,
      stdout: envelope({ tests: [{ name: "Codeunit1.X", status: "pass" }], total: 1 }),
      stderr: "",
    });
    expect(r).toEqual({ kind: "substring", reason: "exit 6 but 1 test row(s)" });
  });

  test("P6: exit 6 with envelope exitCode 0 is substring", () => {
    const r = classifyTestExactProbe({
      kind: "exited",
      exitCode: 6,
      stdout: envelope({ exitCode: 0 }),
      stderr: "",
    });
    expect(r).toEqual({ kind: "substring", reason: "exit 6 but envelope exitCode 0" });
  });

  test("P7 (classifier): a signal exit, the deadline and a spawn failure are substring", () => {
    expect(
      classifyTestExactProbe({ kind: "exited", exitCode: 143, stdout: C5_STDOUT, stderr: "" }),
    ).toEqual({ kind: "substring", reason: "signal exit 143" });
    expect(classifyTestExactProbe({ kind: "deadline" })).toEqual({
      kind: "substring",
      reason: "deadline",
    });
    expect(classifyTestExactProbe({ kind: "spawn-failed", message: "ENOENT" })).toEqual({
      kind: "substring",
      reason: "spawn failed: ENOENT",
    });
  });
});

async function backendWith(spawn: SpawnFn, extra: { serverMode?: true } = {}) {
  const dir = scratch("lethal-r551-");
  await writeFile(join(dir, "MutationSelector.Codeunit.al"), "placeholder", "utf8");
  return new AlRunnerBackend(
    {
      alRunnerPath: "/opt/al-runner",
      instrumentedDir: dir,
      testDir: "/tests",
      selectorObjectId: 50000,
      ...extra,
    },
    spawn,
    // Never called: a probe under serverMode must not start anything.
    extra.serverMode === true
      ? () => {
          throw new Error("no daemon in this test");
        }
      : undefined,
  );
}

describe("AlRunnerBackend.probeExactTestSelector (R551)", () => {
  test("P7 (probe): a signal exit, the deadline and a rejecting spawn are substring, never a throw", async () => {
    const signal = await backendWith(async () => ({
      exitCode: 143,
      stdout: C5_STDOUT,
      stderr: "",
    }));
    const s = await signal.probeExactTestSelector();
    expect(s.kind === "substring" ? s.reason : s.kind).toBe("signal exit 143");

    // Resolves only when aborted, as `defaultSpawn` does on a killed child.
    const hung = await backendWith(
      (_argv, opts) =>
        new Promise((resolve) => {
          opts?.signal?.addEventListener("abort", () =>
            resolve({ exitCode: 143, stdout: "", stderr: "" }),
          );
        }),
    );
    const d = await hung.probeExactTestSelector(50);
    expect(d.kind === "substring" ? d.reason : d.kind).toBe("deadline");

    const rejecting = await backendWith(async () => {
      throw new Error("ENOENT: no such file");
    });
    const f = await rejecting.probeExactTestSelector();
    expect(f.kind === "substring" ? f.reason : f.kind).toBe("spawn failed: ENOENT: no such file");
  });

  test("P8: one call through the INJECTED spawn, exact argv, on an existing empty dir", async () => {
    const calls: string[][] = [];
    const listings: (string[] | undefined)[] = [];
    const backend = await backendWith(async (argv) => {
      calls.push([...argv]);
      const dir = argv[argv.length - 1] ?? "";
      listings.push(existsSync(dir) ? await readdir(dir) : undefined);
      return { exitCode: 6, stdout: C5_STDOUT, stderr: C5_STDERR };
    });
    const p = await backend.probeExactTestSelector();
    expect(p.kind).toBe("exact");
    expect(calls.length).toBe(1);
    const [argv] = calls;
    const dir = argv?.[4] ?? "";
    expect(argv).toEqual([
      "/opt/al-runner",
      "--output-json",
      "--test-exact",
      TEST_EXACT_PROBE_NAME,
      dir,
    ]);
    expect(TEST_EXACT_PROBE_NAME).toBe("Codeunit0.LethalR551NoSuchTest");
    expect(listings).toEqual([[]]);
    // Removed afterwards.
    expect(existsSync(dir)).toBe(false);
  });

  test("P9: under serverMode the probe is not-applicable and spawns nothing", async () => {
    let spawned = 0;
    const backend = await backendWith(
      async () => {
        spawned++;
        return { exitCode: 6, stdout: C5_STDOUT, stderr: "" };
      },
      { serverMode: true },
    );
    expect(await backend.probeExactTestSelector()).toEqual({ kind: "not-applicable" });
    expect(spawned).toBe(0);
  });
});

/**
 * R551 backend tests. `QUALIFIED` and `TWIN` are R488's look-alike pair: al-runner's `--test` is a
 * case-insensitive substring match, so `--test QUALIFIED` also selects `TWIN`.
 */
describe("AlRunnerBackend one-shot after the --test-exact probe (R551)", () => {
  const ref = { codeunitId: 79100, codeunitName: "Sandbox Tests", method: "PostingUpdatesTotal" };
  const QUALIFIED = "Codeunit79100.PostingUpdatesTotal";
  const TWIN = `${QUALIFIED}Twin`;
  const opts = { coverage: "none", timeoutMs: 5000 } as const;
  const discovered = [ref, { ...ref, method: `${ref.method}Twin` }];
  const LINE: Record<string, number> = { [QUALIFIED]: 5, [TWIN]: 10 };
  const COVERED_AL = `codeunit 79150 "Probe One"
{
    procedure Reached()
    begin
        exit;
    end;

    procedure Other()
    begin
        exit;
    end;
}
`;

  /**
   * A fake al-runner. The probe call (no `--test`) answers as c5bbaf89 (`accept`) or 43f76177. A
   * test call selects as the real build does: `--test` keeps names CONTAINING it, ignoring case;
   * `--exclude-test` drops a WHOLE name; `--test-exact` (only when `honoursExact`) keeps a WHOLE
   * name, ignoring case, intersected with `--test`, as c5bbaf89 does (measure.md row 10). With
   * `honoursExact: false` it is R488's substring runner, ignoring `--test-exact`. `rows` overrides
   * the selected names.
   */
  function runner(o: { accept: boolean; honoursExact: boolean; rows?: readonly string[] }) {
    const calls: string[][] = [];
    const spawn: SpawnFn = async (argv) => {
      calls.push([...argv]);
      if (!argv.includes("--test")) {
        return o.accept ? c5Answer() : { exitCode: 2, stdout: "", stderr: N43_STDERR };
      }
      const pattern = (argv[argv.indexOf("--test") + 1] ?? "").toLowerCase();
      const pick = (flag: string) =>
        argv.filter((_, i) => argv[i - 1] === flag).map((n) => n.toLowerCase());
      const excluded = pick("--exclude-test");
      const exact = o.honoursExact ? pick("--test-exact") : [];
      const ran =
        o.rows ??
        [QUALIFIED, TWIN].filter(
          (n) =>
            n.toLowerCase().includes(pattern) &&
            !excluded.includes(n.toLowerCase()) &&
            (exact.length === 0 || exact.includes(n.toLowerCase())),
        );
      const out = argv[argv.indexOf("--coverage-out") + 1];
      if (argv.includes("--coverage-out") && out !== undefined) {
        const lines = ran.map((n) => `<line number="${LINE[n] ?? 1}" hits="1"/>`).join("");
        await writeFile(
          out,
          `<coverage><packages><package><classes><class name="x" filename="One.Codeunit.al"><lines>${lines}</lines></class></classes></package></packages></coverage>`,
          "utf8",
        );
      }
      const tests = ran.map((name) => ({ name, status: "pass", durationMs: 1 }));
      return { exitCode: 0, stdout: alRunnerStdout({ tests }), stderr: "" };
    };
    const testCalls = () => calls.filter((a) => a.includes("--test"));
    return { calls, testCalls, spawn };
  }
  const c5Answer = () => ({ exitCode: 6, stdout: C5_STDOUT, stderr: C5_STDERR });

  const excludesOf = (argv: readonly string[] | undefined) =>
    (argv ?? []).filter((_, i) => argv?.[i - 1] === "--exclude-test");

  test("B1: after an accepting probe, ONE call with --test X --test-exact X and no excludes; credited", async () => {
    const r = runner({ accept: true, honoursExact: true });
    const backend = await backendWith(r.spawn);
    backend.useDiscoveredTests(discovered);
    expect((await backend.probeExactTestSelector()).kind).toBe("exact");
    const v = await backend.run(ref, opts);
    expect(v.outcome).toBe("pass");
    expect(r.testCalls().length).toBe(1);
    const argv = r.testCalls()[0] ?? [];
    const t = argv.indexOf("--test");
    expect(argv.slice(t, t + 4)).toEqual(["--test", QUALIFIED, "--test-exact", QUALIFIED]);
    expect(argv).not.toContain("--exclude-test");
  });

  test("B2: after a rejecting probe (43f76177), the first call excludes the twin and has no --test-exact", async () => {
    const r = runner({ accept: false, honoursExact: false });
    const backend = await backendWith(r.spawn);
    backend.useDiscoveredTests(discovered);
    const p = await backend.probeExactTestSelector();
    expect(p.kind).toBe("substring");
    expect((await backend.run(ref, opts)).outcome).toBe("pass");
    const first = r.testCalls()[0];
    expect(first).not.toContain("--test-exact");
    expect(excludesOf(first)).toEqual([TWIN]);
  });

  test("B3: a backend nobody probed stays on R488's path: no --test-exact, the twin excluded", async () => {
    const r = runner({ accept: true, honoursExact: true });
    const backend = await backendWith(r.spawn);
    backend.useDiscoveredTests(discovered);
    expect((await backend.run(ref, opts)).outcome).toBe("pass");
    expect((await backend.run(ref, opts)).outcome).toBe("pass");
    for (const argv of r.calls) expect(argv).not.toContain("--test-exact");
    expect(excludesOf(r.calls[0])).toEqual([TWIN]);
  });

  test("B4: on the exact path a result naming another test is refused at once, by name", async () => {
    // The probe accepts, but the runner then ignores --test-exact (substring only).
    const r = runner({ accept: true, honoursExact: false });
    const backend = await backendWith(r.spawn);
    backend.useDiscoveredTests(discovered);
    await backend.probeExactTestSelector();
    const v = await backend.run(ref, opts);
    expect(v.outcome).toBe("error");
    expect(v.failureMessage).toContain(TWIN);
    expect(v.failureMessage).toContain("--test-exact");
    expect(v.operation).toBe("completed-accepted");
    expect(r.testCalls().length).toBe(1);
  });

  test("B6: R491's duplicate-row refusal still comes first on the exact path", async () => {
    const r = runner({ accept: true, honoursExact: true, rows: [QUALIFIED, QUALIFIED] });
    const backend = await backendWith(r.spawn);
    await backend.probeExactTestSelector();
    const v = await backend.run(ref, opts);
    expect(v.outcome).toBe("error");
    expect(v.failureMessage).toContain("2 rows");
    expect(v.failureMessage).toContain("R491");
    expect(r.testCalls().length).toBe(1);
  });

  test("B7: coverage on the exact path is credited from the single call", async () => {
    const r = runner({ accept: true, honoursExact: true });
    const dir = scratch("lethal-r551-cov-");
    await writeFile(join(dir, "One.Codeunit.al"), COVERED_AL, "utf8");
    await writeFile(join(dir, "MutationSelector.Codeunit.al"), "placeholder", "utf8");
    const backend = new AlRunnerBackend(
      {
        alRunnerPath: "al-runner",
        instrumentedDir: dir,
        testDir: "/tests",
        selectorObjectId: 50000,
        coverage: "al-runner",
      },
      r.spawn,
    );
    backend.useBuildSymbols([]);
    backend.useDiscoveredTests(discovered);
    await backend.probeExactTestSelector();
    const v = await backend.run(ref, opts);
    await backend.close();
    expect(v.outcome).toBe("pass");
    expect(r.testCalls().length).toBe(1);
    expect(r.testCalls()[0]).toContain("--test-exact");
    expect((v.coverage?.entries ?? []).map((e) => e.procedure)).toEqual(["Reached"]);
  });

  test("B8: accepted, then useExactTestSelector(false), or a second rejecting probe, goes back to R488", async () => {
    // (a) the setter resets it.
    const a = runner({ accept: true, honoursExact: true });
    const ba = await backendWith(a.spawn);
    ba.useDiscoveredTests(discovered);
    expect((await ba.probeExactTestSelector()).kind).toBe("exact");
    ba.useExactTestSelector(false);
    await ba.run(ref, opts);
    expect(a.testCalls()[0]).not.toContain("--test-exact");
    expect(excludesOf(a.testCalls()[0])).toEqual([TWIN]);

    // (b) a second probe that rejects resets it.
    let accept = true;
    const inner = runner({ accept: true, honoursExact: true });
    const spawn: SpawnFn = async (argv, o) =>
      !argv.includes("--test") && !accept
        ? { exitCode: 2, stdout: "", stderr: N43_STDERR }
        : inner.spawn(argv, o);
    const bb = await backendWith(spawn);
    bb.useDiscoveredTests(discovered);
    expect((await bb.probeExactTestSelector()).kind).toBe("exact");
    accept = false;
    expect((await bb.probeExactTestSelector()).kind).toBe("substring");
    await bb.run(ref, opts);
    expect(inner.testCalls()[0]).not.toContain("--test-exact");
    expect(excludesOf(inner.testCalls()[0])).toEqual([TWIN]);
  });

  test("useExactTestSelector(true) puts a worker on the exact path", async () => {
    const r = runner({ accept: true, honoursExact: true });
    const backend = await backendWith(r.spawn);
    backend.useDiscoveredTests(discovered);
    backend.useExactTestSelector(true);
    expect((await backend.run(ref, opts)).outcome).toBe("pass");
    expect(r.calls.length).toBe(1);
    expect(r.calls[0]).toContain("--test-exact");
  });
});

// The gate's checks (`itest:alrunner`), offline: `cli-default-leg.ts` holds them for this reason.
describe("itest:alrunner selector checks (R551)", () => {
  const selector = (message: string): RunEvent => ({
    seq: 2,
    type: "warning",
    code: "al-runner-test-selector",
    message,
  });
  const other: RunEvent = { seq: 1, type: "warning", code: "something-else", message: "x" };
  const EXACT =
    "al-runner test selector: exact (--test-exact accepted by a one-call probe in 5 ms; R551)";

  test("I3: the cli-default hook passes with other events and no selector event", () => {
    expect(cliDefaultSelectorFailures([other])).toEqual([]);
  });

  test("I3: a hook that received nothing FAILS: the zero would be vacuous", () => {
    const f = cliDefaultSelectorFailures([]);
    expect(f.length).toBe(1);
    expect(f[0]).toContain("vacuous");
  });

  test("I3: a selector event on the cli-default (--server) leg fails", () => {
    const f = cliDefaultSelectorFailures([other, selector(EXACT)]);
    expect(f.length).toBe(1);
    expect(f[0]).toContain("al-runner-test-selector");
  });

  test("runOnce legs: exactly one selector line on a one-shot leg, none on a server leg", () => {
    expect(testSelectorLineFailures([EXACT], true)).toEqual([]);
    expect(testSelectorLineFailures([], false)).toEqual([]);
    expect(testSelectorLineFailures([], true).length).toBe(1);
    expect(testSelectorLineFailures([EXACT, EXACT], true).length).toBe(1);
    expect(testSelectorLineFailures([EXACT], false).length).toBe(1);
  });
});
