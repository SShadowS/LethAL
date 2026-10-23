// R586 §8 and §12: the v3 contract probe against a fake v3 (and a fake alc), and the `.gated`
// pin (T18). Every refusal has a test per direction.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  V3_DEFECT_FACTS,
  V3_LEG_C_FACTS,
  V3_WARN_FACTS,
  classifyLegC,
  legCFactLine,
} from "../itest/al-runner-v3-gate";
import type { ServerSpawnFn } from "../src/al-runner-server";
import type { V3Row } from "../src/al-runner-v3-backend";
import {
  BC_END_OF_TEST_TEXT,
  BC_HTTP_INTERNAL_TEXT,
  MESSAGE_PREFIX_REASON,
  type V3ContractResult,
  classifySleep,
  runV3ContractProbe,
  v3ContractRefusals,
  v3DefectWarnings,
  v3DefectsGone,
} from "../src/al-runner-v3-contract";
import {
  AlRunnerV3UngatedBuildError,
  checkGated,
  parseGated,
  sha256OfFile,
} from "../src/al-runner-v3-pin";
import { V3_PREDEFINED_CANDIDATES } from "../src/al-runner-v3-probe";
import type { ArtifactIo } from "../src/artifact";
import type { SpawnFn } from "../src/publisher";

const VERSION = "alrunner 3.0.0-alpha.2 (91253f2d6)";
const BC = "28.0.46665.47126";

type Over = Partial<
  Record<
    string,
    (argv: readonly string[]) => { exitCode: number; stdout: string; stderr?: string } | undefined
  >
>;

const row = (
  cu: number,
  method: string,
  status: string,
  o: { message?: string; notRun?: boolean; durationMs?: number } = {},
) => ({
  codeunit: cu,
  method,
  name: `Codeunit${cu}.${method}`,
  status,
  durationMs: o.durationMs ?? 0,
  ...(o.message !== undefined ? { message: o.message } : {}),
  ...(o.notRun === true ? { notRun: true } : {}),
});
const doc = (tests: unknown[]) => JSON.stringify({ tests });
const NOT_TRUSTED_MESSAGE =
  "NotRun: out-of-scope: an earlier test of this codeunit was refused while it ran (HangsDirty: did not run (the test used more than the time limit of 3 s of CPU time and was stopped (--test-timeout-secs)): it can change the global variable Probe Cut.Dirty that this test reads, so the state it would have left is not BC's; this failure is not trusted: dirty";
const CUT_TIMEOUT = row(50652, "HangsDirty", "error", {
  notRun: true,
  message: "Test exceeded 3s timeout.",
  durationMs: 3007,
});
const CUT_NOT_TRUSTED = row(50652, "ChecksClean", "error", {
  notRun: true,
  message: NOT_TRUSTED_MESSAGE,
});
const cutRows = [CUT_TIMEOUT, CUT_NOT_TRUSTED];
const PUBLIC_REFUSED = row(50654, "HttpGetPublic", "error", {
  notRun: true,
  message: "NotRun: out-of-scope: an outbound HTTP request",
});
const PUBLIC_LATER_NOTRUN = row(50654, "LaterFails", "error", {
  notRun: true,
  message: "NotRun: out-of-scope: an earlier test was refused",
});
const PUBLIC_ROWS = [PUBLIC_REFUSED, PUBLIC_LATER_NOTRUN];
const ASSERT_ROW = row(50661, "AssertAreEqual", "fail", {
  message:
    "Assert.AreEqual failed. Expected:<1> (Integer). Actual:<2> (Integer). R667 values differ.",
});
const LIBRARY_ASSERT = "/fake/ms/Microsoft_Library Assert_28.0.46665.49944.app";
/** R590 (R-537): v3's skip line for the probe's absent dependency, in the shape R-537 measured. */
const DEP_SKIP_STDERR =
  "dependency skipped: dependency `LethAL R590 Absent` by LethAL (7a1c0e52-5b8e-4d3a-9f60-2c7b8e1d2590) version 1.0.0.0 or higher was not found; searched: /fake/pkgs; put its .app with AL source (or its source archive) in the project's .alpackages or pass --deps DIR\nalrunner 3.0.0-alpha.2 (91253f2d6)\n";

/** A fake alpha.2 that answers every probe call as measured; `over` replaces one answer by key. */
function fakeV3(over: Over = {}): SpawnFn {
  return async (argv, _opts) => {
    const a = argv[0] === "/usr/bin/taskset" ? argv.slice(3) : argv;
    const has = (x: string) => a.includes(x);
    const val = (x: string) => a[a.indexOf(x) + 1] ?? "";
    const key =
      a[1] === "--version"
        ? "version"
        : has("--lethal-wire-contract-probe")
          ? "bad"
          : has("--test-exact")
            ? val("--test-exact").includes("Space")
              ? "quoted"
              : "exact"
            : `cu${val("--codeunit")}${has("--define") ? "-def" : ""}${argv[0] === "/usr/bin/taskset" ? "-shared" : ""}${a.some((x) => x.includes("/broken/")) ? "-broken" : ""}${a.some((x) => x.includes("tests-pinned")) ? "-pinned" : ""}${has("--test-timeout-secs") ? `-n${val("--test-timeout-secs")}` : ""}`;
    const o = over[key]?.(a);
    if (o !== undefined) return { stderr: "", ...o };
    if (has("--coverage-json")) {
      const cov = val("--coverage-json");
      const cu = val("--codeunit");
      const first = "/p/app/src/First.Codeunit.al";
      const body =
        cu === "50650"
          ? {
              coverage: [
                {
                  file: first,
                  statements: [
                    { line: 5, hits: 1 },
                    { line: 6, hits: 0 },
                    { line: 7, hits: 1 },
                  ],
                },
              ],
              perTestCoverage: [
                {
                  test: "Codeunit50650.CoversOnlyA",
                  coverage: [
                    {
                      file: first,
                      statements: [
                        { line: 5, hits: 1 },
                        { line: 7, hits: 1 },
                      ],
                    },
                  ],
                },
              ],
            }
          : {
              coverage: [
                {
                  file: "/p/tests/src/SleepProbe.Codeunit.al",
                  statements: [{ line: 17, hits: 1 }],
                },
                { file: "/p/app/src/Sleeper.Codeunit.al", statements: [{ line: 5, hits: 1 }] },
              ],
              perTestCoverage: [
                {
                  test: "Codeunit50660.LongSleepA",
                  coverage: [
                    {
                      file: "/p/tests/src/SleepProbe.Codeunit.al",
                      statements: [{ line: 17, hits: 1 }],
                    },
                  ],
                },
                {
                  test: "Codeunit50660.SleeperDoubles",
                  coverage: [
                    { file: "/p/app/src/Sleeper.Codeunit.al", statements: [{ line: 5, hits: 1 }] },
                  ],
                },
              ],
            };
      await writeFile(cov, JSON.stringify(body));
    }
    const mainRows = (arm: string) => [
      row(50650, "Passes", "pass"),
      row(50650, "Fails", "fail", { message: "boom 5" }),
      row(50650, "Space Step", "pass"),
      row(50650, "PersistA", "pass"),
      row(50650, "PersistB", "fail", { message: "rows=0 counter=1" }),
      row(50650, "ArmIs", "fail", { message: `arm=${arm}` }),
      row(50650, "CoversOnlyA", "pass"),
    ];
    const sleepRows = [
      row(50660, "ShortSleep", "pass"),
      row(50660, "LongSleepA", "pass"),
      row(50660, "LongSleepB", "pass"),
      row(50660, "LongSleepThenAssert", "pass"),
      row(50660, "SleeperDoubles", "pass"),
    ];
    const answers: Record<string, { exitCode: number; stdout: string; stderr?: string }> = {
      version: { exitCode: 0, stdout: `${VERSION}\n` },
      bad: { exitCode: 2, stdout: "" },
      cu50650: {
        exitCode: 1,
        stdout: doc(mainRows("none")),
        stderr: `target: BC ${BC}, runtime 16.0\n`,
      },
      "cu50650-def": { exitCode: 1, stdout: doc(mainRows("A")) },
      exact: { exitCode: 1, stdout: doc(mainRows("none")) },
      cu0: { exitCode: 6, stdout: "" },
      quoted: { exitCode: 6, stdout: "" },
      "cu50651-n3": {
        exitCode: 7,
        stdout: doc([
          row(50651, "CpuHang", "error", { notRun: true, message: "Test exceeded 3s timeout." }),
        ]),
      },
      "cu50656-n2": {
        exitCode: 7,
        stdout: doc([
          row(50656, "CpuBurnLong", "error", {
            notRun: true,
            message: "Test exceeded 2s timeout.",
          }),
        ]),
      },
      "cu50658-shared-n2": {
        exitCode: 0,
        stdout: doc([row(50658, "CpuBurnShort", "pass", { durationMs: 3105 })]),
      },
      cu50653: {
        exitCode: 7,
        stdout: doc([
          row(50653, "HttpGet", "error", {
            notRun: true,
            message: "NotRun: out-of-scope: an outbound HTTP request",
          }),
          row(50653, "LaterFails", "error", {
            notRun: true,
            message: "NotRun: out-of-scope: an earlier test was refused",
          }),
        ]),
      },
      // r9 (R639): inferred for alpha.2 (M8): every unhandled HttpClient call refused, then the cascade.
      cu50654: { exitCode: 7, stdout: doc(PUBLIC_ROWS) },
      cu50657: {
        exitCode: 7,
        stdout: doc([
          row(50657, "CommitCall", "error", {
            notRun: true,
            message: "NotRun: out-of-scope: Commit",
          }),
        ]),
      },
      // r8 (R-637), as measured on alpha.2 (/coord/handoff/R-637/r8-measure/out/cut.stdout).
      "cu50652-n3": { exitCode: 7, stdout: doc(cutRows) },
      // R667: the Assert.AreEqual text R657 measured on alpha.2 and edge (no `<Type>: ` prefix).
      cu50661: { exitCode: 1, stdout: doc([ASSERT_ROW]) },
      // R590 (R-537): the shape alpha.2 and edge wrote for a dependency with no package (probe M).
      cu50662: { exitCode: 0, stdout: doc([row(50662, "Runs", "pass")]), stderr: DEP_SKIP_STDERR },
      cu50655: { exitCode: 0, stdout: doc([row(50655, "DuplicateNamedKey", "pass")]) },
      "cu50660-n3": { exitCode: 1, stdout: doc(sleepRows) },
      cu50660: { exitCode: 1, stdout: doc(sleepRows) },
      cu50191: {
        exitCode: 1,
        stdout: doc([
          row(50191, "ProbeMask", "fail", {
            message: `R586MASK:+ALWAYS ${V3_PREDEFINED_CANDIDATES.map((c) => `-${c}`).join(" ")}:END`,
          }),
        ]),
      },
      "cu50650-broken": { exitCode: 7, stdout: doc([row(50650, "Passes", "pass")]) },
      "cu50650-pinned": { exitCode: 1, stdout: doc(mainRows("none")) },
    };
    const ans = answers[key];
    if (ans === undefined) throw new Error(`fake v3: no answer for ${key}: ${argv.join(" ")}`);
    return { stderr: "", ...ans };
  };
}

/** A fake alc that rejects the broken target and compiles everything else. */
const fakeAlcIo: ArtifactIo = {
  spawn: async (argv) => {
    const project = argv.find((a) => a.startsWith("/project:")) ?? "";
    const out = (argv.find((a) => a.startsWith("/out:")) ?? "").slice(5);
    if (project.includes("/broken/")) return { exitCode: 1, stdout: "error AL0118", stderr: "" };
    await writeFile(out, "app");
    return { exitCode: 0, stdout: "", stderr: "" };
  },
  readArtifact: async (p) => new Uint8Array(await Bun.file(p).arrayBuffer()),
  writeArtifact: async (from, to) => {
    const { rename } = await import("node:fs/promises");
    await rename(from, to);
  },
};

/** R612: the serve rows as measured on alpha.2 (`/coord/handoff/R-612/measure.md`), by name. */
const SERVE_ROWS: Record<string, { status: string; notRun?: boolean; message?: string }> = {
  "Codeunit50670.HttpGet": {
    status: "error",
    notRun: true,
    message:
      "NotRun: out-of-scope: an outbound HTTP request with no [HttpClientHandler] bound to the test: the runtime never opens a connection (ADR-027)",
  },
  "Codeunit50671.CommitCall": {
    status: "error",
    notRun: true,
    message:
      "NotRun: out-of-scope: Commit inside a test under TestIsolation = Function: what the runner keeps is not pinned",
  },
  "Codeunit50672.HttpGet": {
    status: "error",
    notRun: true,
    message:
      "NotRun: out-of-scope: an outbound HTTP request with no [HttpClientHandler] bound to the test: the runtime never opens a connection (ADR-027)",
  },
  "Codeunit50672.LaterFails": {
    status: "error",
    notRun: true,
    message:
      "NotRun: out-of-scope: an earlier test of this codeunit was refused while it ran (HttpGet: did not run (an outbound HTTP request ...): this failure is not trusted: after a refusal",
  },
  "Codeunit50673.Never": {
    status: "error",
    notRun: true,
    message:
      "NotRun: out-of-scope: OnRun failed (runner behaviour not pinned): Arithmetic operation resulted in an overflow.",
  },
  "Codeunit50674.DoesNotCompile": {
    status: "error",
    notRun: true,
    message:
      "NotRun: out-of-scope: Serve NoCallee.DoesNotCompile: call `NoSuchProcedure(1)` has no callee the checker resolved",
  },
};

/** A fake `alrunner serve`: answers every runTests with `rows`; records each argv and request. */
function fakeServe(
  rows: Record<string, { status: string; notRun?: boolean; message?: string }> = SERVE_ROWS,
  o: { ready?: boolean } = {},
): { spawn: ServerSpawnFn; argvs: string[][]; requests: Record<string, unknown>[] } {
  const argvs: string[][] = [];
  const requests: Record<string, unknown>[] = [];
  const spawn: ServerSpawnFn = (argv) => {
    argvs.push([...argv]);
    const queue: Array<Uint8Array | null> = [];
    let waiter: (() => void) | undefined;
    const push = (c: Uint8Array | null): void => {
      queue.push(c);
      waiter?.();
      waiter = undefined;
    };
    const emit = (l: string): void => push(new TextEncoder().encode(`${l}\n`));
    queueMicrotask(() => (o.ready === false ? push(null) : emit('{"ready":true}')));
    return {
      write: (line: string) => {
        const req = JSON.parse(line) as Record<string, unknown>;
        requests.push(req);
        if (req.command === "runTests") {
          for (const [name, r] of Object.entries(rows))
            emit(JSON.stringify({ type: "test", name, ...r }));
          emit(JSON.stringify({ type: "summary", exitCode: 7 }));
        }
        if (req.command === "shutdown") emit('{"status":"shutting down"}');
      },
      stdout: {
        async *[Symbol.asyncIterator]() {
          for (;;) {
            if (queue.length === 0) {
              await new Promise<void>((r) => {
                waiter = r;
              });
              continue;
            }
            const next = queue.shift();
            if (next === null || next === undefined) return;
            yield next;
          }
        },
      },
      stderr: { async *[Symbol.asyncIterator]() {} },
      kill: () => push(null),
    };
  };
  return { spawn, argvs, requests };
}

const probe = (over: Over = {}, serveSpawn = fakeServe().spawn): Promise<V3ContractResult> =>
  runV3ContractProbe({
    alRunnerPath: "/fake/alrunner",
    expectedVersion: VERSION,
    packagesDir: "/fake/deps",
    bcVersion: BC,
    alcPath: "/fake/alc",
    alcIo: fakeAlcIo,
    tasksetPath: "/usr/bin/taskset",
    startBurner: () => ({ kill: () => {} }),
    spawn: fakeV3(over),
    serveSpawn,
    libraryAssertApp: LIBRARY_ASSERT,
  });

describe("R612 serve-keep-reasons: a warn fact that pins V3_SERVE_SAFE_REFUSALS on serve rows", () => {
  test("alpha.2 as measured: matches, kind warn; one serve daemon with --test-timeout, isolation test", async () => {
    const s = fakeServe();
    const r = await probe({}, s.spawn);
    const f = r.facts.find((x) => x.fact === "serve-keep-reasons");
    expect(f).toMatchObject({ kind: "warn", verdict: "matches" });
    expect(s.argvs).toEqual([["/fake/alrunner", "serve", "--test-timeout", "3"]]);
    const run = s.requests.filter((q) => q.command === "runTests");
    expect(run.length).toBe(1);
    expect(run[0]?.testIsolation).toBe("test");
    expect(classifyLegC(r.facts, V3_DEFECT_FACTS, V3_LEG_C_FACTS)).toEqual({
      outcome: "pass",
      lines: [],
    });
  });

  for (const [entry, name] of [
    ["http", "Codeunit50670.HttpGet"],
    ["commit", "Codeunit50671.CommitCall"],
    ["cascade", "Codeunit50672.LaterFails"],
    ["onrun-failed", "Codeunit50673.Never"],
    ["no-callee", "Codeunit50674.DoesNotCompile"],
  ] as const) {
    test(`a reworded ${entry} reason is diverged, names the entry, never refuses, and leg C still passes with the warning`, async () => {
      const rows = {
        ...SERVE_ROWS,
        [name]: { ...SERVE_ROWS[name], message: "NotRun: out-of-scope: reworded" },
      };
      const r = await probe({}, fakeServe(rows as typeof SERVE_ROWS).spawn);
      const f = r.facts.find((x) => x.fact === "serve-keep-reasons");
      expect(f?.verdict).toBe("diverged");
      expect(f?.measured).toContain(`${entry}: MOVED`);
      expect(f?.measured).toContain("reworded");
      expect(v3ContractRefusals(r)).toEqual([]);
      const c = classifyLegC(r.facts, V3_DEFECT_FACTS, V3_LEG_C_FACTS);
      expect(c.outcome).toBe("pass");
      expect(c.lines.join("\n")).toMatch(
        new RegExp(
          `al-runner-v3-serve-keep-reason-moved: serve-keep-reasons: diverged.*${entry}: MOVED`,
        ),
      );
    });
  }

  test("a missing row or a row without notRun is diverged", async () => {
    const { "Codeunit50673.Never": _gone, ...rest } = SERVE_ROWS;
    expect(
      (await probe({}, fakeServe(rest).spawn)).facts.find((x) => x.fact === "serve-keep-reasons")
        ?.verdict,
    ).toBe("diverged");
    const noFlag = {
      ...SERVE_ROWS,
      "Codeunit50671.CommitCall": { ...SERVE_ROWS["Codeunit50671.CommitCall"], notRun: false },
    } as typeof SERVE_ROWS;
    expect(
      (await probe({}, fakeServe(noFlag).spawn)).facts.find((x) => x.fact === "serve-keep-reasons")
        ?.verdict,
    ).toBe("diverged");
  });

  test("serve does not start: unmeasurable, which only warns (leg C passes)", async () => {
    const r = await probe({}, fakeServe(SERVE_ROWS, { ready: false }).spawn);
    expect(r.facts.find((x) => x.fact === "serve-keep-reasons")?.verdict).toBe("unmeasurable");
    expect(v3ContractRefusals(r)).toEqual([]);
    const c = classifyLegC(r.facts, V3_DEFECT_FACTS, V3_LEG_C_FACTS);
    expect(c.outcome).toBe("pass");
    expect(c.lines.join("\n")).toMatch(
      /al-runner-v3-serve-keep-reason-moved: serve-keep-reasons: unmeasurable/,
    );
  });

  test("V3_WARN_FACTS is exactly serve-keep-reasons, and the same divergence on a CONTRACT fact list would gate-fail", async () => {
    expect([...V3_WARN_FACTS]).toEqual(["serve-keep-reasons"]);
    const rows = {
      ...SERVE_ROWS,
      "Codeunit50671.CommitCall": { ...SERVE_ROWS["Codeunit50671.CommitCall"], message: "x" },
    } as typeof SERVE_ROWS;
    const r = await probe({}, fakeServe(rows).spawn);
    expect(classifyLegC(r.facts, V3_DEFECT_FACTS, V3_LEG_C_FACTS, []).outcome).toBe("gate-fail");
  });

  const session = (s: ReturnType<typeof fakeServe>, gated?: Record<string, string>) =>
    runV3ContractProbe({
      alRunnerPath: "/fake/alrunner",
      expectedVersion: VERSION,
      packagesDir: "/fake/deps",
      bcVersion: BC,
      alcPath: "/fake/alc",
      alcIo: fakeAlcIo,
      tasksetPath: "/usr/bin/taskset",
      startBurner: () => ({ kill: () => {} }),
      spawn: fakeV3(),
      serveSpawn: s.spawn,
      gateOnlyTrusted: "the gated build's leg C at 5eb544ef",
      ...(gated !== undefined ? { gatedWarnFacts: gated } : {}),
    });

  test("M-2: a session never starts serve and shows the GATE's reading, not a claimed matches", async () => {
    for (const v of ["matches", "diverged"]) {
      const s = fakeServe();
      const r = await session(s, { "serve-keep-reasons": v });
      expect(s.argvs).toEqual([]);
      const f = r.facts.find((x) => x.fact === "serve-keep-reasons");
      expect(f).toMatchObject({ kind: "warn", verdict: v });
      expect(f?.measured).toBe(
        `not re-measured in a session (gate-only); the gate read ${v} (the gated build's leg C at 5eb544ef)`,
      );
      expect(v3ContractRefusals(r)).toEqual([]);
    }
  });

  test("M-2: a .gated without the reading (gated before R612) is unmeasurable, never matches", async () => {
    const s = fakeServe();
    const r = await session(s);
    expect(s.argvs).toEqual([]);
    const f = r.facts.find((x) => x.fact === "serve-keep-reasons");
    expect(f).toMatchObject({ kind: "warn", verdict: "unmeasurable" });
    expect(f?.measured).toMatch(/\.gated records no reading/);
    expect(v3ContractRefusals(r)).toEqual([]);
  });
});

describe("§8 the contract probe", () => {
  test("alpha.2 as measured: every contract fact matches and every defect is present", async () => {
    const r = await probe();
    const bad = r.facts.filter((f) => f.verdict !== "matches" && f.verdict !== "defect-present");
    expect(bad).toEqual([]);
    expect(v3ContractRefusals(r)).toEqual([]);
    expect(r.facts.map((f) => f.fact).sort()).toEqual(
      [
        "version",
        "unknown-flag-rejected",
        "rows-shape",
        "quoted-name-in-rows",
        "bc-build-pinned",
        "define-honoured",
        "dependency-skip-line",
        "per-test-coverage",
        "codeunit-runs-whole",
        "codeunit-row-equals-exact-row",
        "none-selected-exit",
        "quoted-name-unselectable",
        "timeout-classified",
        "timeout-is-cpu",
        "refusal-row-shape",
        "refusal-row-shape-public",
        "refusal-cascade",
        "commit-under-test-isolation",
        "duplicate-key-insert-raises",
        "sleep-is-noop",
        "sleep-line-covered",
        "predefined-symbols",
        "compile-failure-not-scorable",
        "upstream-compile-errors",
        "positional-target-wins",
        "serve-keep-reasons",
        "dependent-fail-after-timeout-is-notrun",
        "message-has-no-type-prefix",
      ].sort(),
    );
  });

  test("a contract fact that diverges refuses (timeout wording moved)", async () => {
    const r = await probe({
      "cu50651-n3": () => ({
        exitCode: 7,
        stdout: doc([
          row(50651, "CpuHang", "error", { notRun: true, message: "TIMEOUT after 3s" }),
        ]),
      }),
    });
    expect(v3ContractRefusals(r).join("\n")).toMatch(/timeout-classified/);
  });

  test("timeout-is-cpu diverges when the shared-core run is ALSO stopped (a wall-time stop)", async () => {
    const r = await probe({
      "cu50658-shared-n2": () => ({
        exitCode: 7,
        stdout: doc([
          row(50658, "CpuBurnShort", "error", {
            notRun: true,
            message: "Test exceeded 2s timeout.",
          }),
        ]),
      }),
    });
    expect(r.facts.find((f) => f.fact === "timeout-is-cpu")?.verdict).toBe("diverged");
  });

  test("timeout-is-cpu diverges when the alone run is NOT stopped (no CPU timeout at all)", async () => {
    const r = await probe({
      "cu50656-n2": () => ({ exitCode: 0, stdout: doc([row(50656, "CpuBurnLong", "pass")]) }),
    });
    expect(r.facts.find((f) => f.fact === "timeout-is-cpu")?.verdict).toBe("diverged");
  });

  test("timeout-is-cpu diverges when the shared pass did not actually take over N of wall", async () => {
    const r = await probe({
      "cu50658-shared-n2": () => ({
        exitCode: 0,
        stdout: doc([row(50658, "CpuBurnShort", "pass", { durationMs: 1500 })]),
      }),
    });
    expect(r.facts.find((f) => f.fact === "timeout-is-cpu")?.verdict).toBe("diverged");
  });

  test("a predefined symbol diverges predefined-symbols", async () => {
    const r = await probe({
      cu50191: () => ({
        exitCode: 1,
        stdout: doc([
          row(50191, "ProbeMask", "fail", {
            message: `R586MASK:+ALWAYS ${V3_PREDEFINED_CANDIDATES.map((c) => (c === "CLEAN" ? "+CLEAN" : `-${c}`)).join(" ")}:END`,
          }),
        ]),
      }),
    });
    expect(r.facts.find((f) => f.fact === "predefined-symbols")?.verdict).toBe("diverged");
  });

  test("a defect that is gone never refuses; it prints al-runner-v3-defect-gone", async () => {
    const r = await probe({
      cu50655: () => ({
        exitCode: 1,
        stdout: doc([row(50655, "DuplicateNamedKey", "fail", { message: BC_END_OF_TEST_TEXT })]),
      }),
    });
    expect(r.facts.find((f) => f.fact === "duplicate-key-insert-raises")?.verdict).toBe("gone");
    expect(v3ContractRefusals(r)).toEqual([]);
    expect(v3DefectsGone(r).join("\n")).toMatch(
      /al-runner-v3-defect-gone: duplicate-key-insert-raises/,
    );
  });

  test("sleep-is-noop reads gone when a Sleep test is stopped as a timeout", async () => {
    const r = await probe({
      "cu50660-n3": () => ({
        exitCode: 7,
        stdout: doc([
          row(50660, "ShortSleep", "pass"),
          row(50660, "LongSleepA", "pass"),
          row(50660, "LongSleepB", "pass"),
          row(50660, "LongSleepThenAssert", "error", {
            notRun: true,
            message: "Test exceeded 3s timeout.",
          }),
          row(50660, "SleeperDoubles", "pass"),
        ]),
      }),
    });
    expect(r.facts.find((f) => f.fact === "sleep-is-noop")?.verdict).toBe("gone");
  });

  test("R632 B (r7): none-selected-exit is a defect fact; #5613's fix (exit 6 with a 0-row document) is gone, so leg C is held", async () => {
    expect(V3_DEFECT_FACTS).toContain("none-selected-exit");
    expect(V3_DEFECT_FACTS.length).toBe(9);
    // alpha.2 as measured: exit 6, no document.
    const before = await probe();
    const f0 = before.facts.find((f) => f.fact === "none-selected-exit");
    expect(f0).toMatchObject({ kind: "defect", verdict: "defect-present" });
    expect(classifyLegC(before.facts, V3_DEFECT_FACTS, V3_LEG_C_FACTS).outcome).toBe("pass");
    // alpha.4 (#5622): exit 6 with a document of 0 rows.
    const r = await probe({ cu0: () => ({ exitCode: 6, stdout: doc([]) }) });
    expect(r.facts.find((f) => f.fact === "none-selected-exit")?.verdict).toBe("gone");
    expect(v3ContractRefusals(r)).toEqual([]);
    expect(v3DefectsGone(r).join("\n")).toMatch(/defect-gone: none-selected-exit/);
    expect(classifyLegC(r.facts, V3_DEFECT_FACTS, V3_LEG_C_FACTS).outcome).toBe("held");
  });

  test("R632 B (r7): none-selected-exit diverges (refuses, gate-fail) on unparseable output, rows, or another exit", async () => {
    for (const answer of [
      { exitCode: 6, stdout: "not json" },
      { exitCode: 6, stdout: doc([row(0, "X", "pass")]) },
      { exitCode: 0, stdout: doc([]) },
      { exitCode: 1, stdout: "" },
    ]) {
      const r = await probe({ cu0: () => answer });
      expect(r.facts.find((f) => f.fact === "none-selected-exit")?.verdict).toBe("diverged");
      expect(v3ContractRefusals(r).join("\n")).toMatch(/DIVERGED — none-selected-exit/);
      expect(classifyLegC(r.facts, V3_DEFECT_FACTS, V3_LEG_C_FACTS).outcome).toBe("gate-fail");
    }
  });

  const DEP = "dependent-fail-after-timeout-is-notrun";
  test("R637 r8 (a): dependent-fail-after-timeout-is-notrun matches v3's measured not-trusted row", async () => {
    const r = await probe();
    expect(r.facts.find((f) => f.fact === DEP)).toMatchObject({
      kind: "contract",
      verdict: "matches",
    });
    expect(r.facts.length).toBe(28);
    expect(classifyLegC(r.facts, V3_DEFECT_FACTS, V3_LEG_C_FACTS).outcome).toBe("pass");
  });

  test("R637 r8 (b): a plain fail after the timeout (the guard dropped) diverges, refuses and is gate-fail", async () => {
    // Exit 1 is the likely shape; exit 7 isolates the row check from the exit-code check.
    for (const exitCode of [1, 7]) {
      const r = await probe({
        "cu50652-n3": () => ({
          exitCode,
          stdout: doc([CUT_TIMEOUT, row(50652, "ChecksClean", "fail", { message: "dirty" })]),
        }),
      });
      expect(r.facts.find((f) => f.fact === DEP)?.verdict).toBe("diverged");
      expect(v3ContractRefusals(r).join("\n")).toMatch(/DIVERGED — dependent-fail-after-timeout/);
      expect(classifyLegC(r.facts, V3_DEFECT_FACTS, V3_LEG_C_FACTS).outcome).toBe("gate-fail");
    }
  });

  test("R637 r8 (c): the not-trusted row missing diverges", async () => {
    const r = await probe({
      "cu50652-n3": () => ({ exitCode: 7, stdout: doc([CUT_TIMEOUT]) }),
    });
    expect(r.facts.find((f) => f.fact === DEP)?.verdict).toBe("diverged");
    expect(classifyLegC(r.facts, V3_DEFECT_FACTS, V3_LEG_C_FACTS).outcome).toBe("gate-fail");
  });

  // Review I1: each condition of the fact has its own red-going test.
  const depOf = async (exitCode: number, rows: unknown[]) =>
    (await probe({ "cu50652-n3": () => ({ exitCode, stdout: doc(rows) }) })).facts.find(
      (f) => f.fact === DEP,
    )?.verdict;

  test("R637 r8 (d): the measured rows at exit 1 or exit 0 diverge", async () => {
    expect(await depOf(1, cutRows)).toBe("diverged");
    expect(await depOf(0, cutRows)).toBe("diverged");
  });

  test("R637 r8 (e1): a HangsDirty row without notRun diverges", async () => {
    const { notRun: _, ...plain } = CUT_TIMEOUT;
    expect(await depOf(7, [plain, CUT_NOT_TRUSTED])).toBe("diverged");
  });

  test("R637 r8 (e2): a HangsDirty row with another timeout text diverges", async () => {
    const two = { ...CUT_TIMEOUT, message: "Test exceeded 2s timeout." };
    expect(await depOf(7, [two, CUT_NOT_TRUSTED])).toBe("diverged");
  });

  test("R637 r8 (f1): a ChecksClean row with the right suffix but another prefix diverges", async () => {
    const m = NOT_TRUSTED_MESSAGE.replace("refused while it ran (HangsDirty: ", "x (");
    expect(await depOf(7, [CUT_TIMEOUT, { ...CUT_NOT_TRUSTED, message: m }])).toBe("diverged");
  });

  test("R637 r8 (f2): a ChecksClean row with the right prefix but another suffix diverges", async () => {
    const m = `${NOT_TRUSTED_MESSAGE.slice(0, -"dirty".length)}clean`;
    expect(await depOf(7, [CUT_TIMEOUT, { ...CUT_NOT_TRUSTED, message: m }])).toBe("diverged");
  });

  test("R637 r8 (g, review M3): a duplicate ChecksClean row diverges", async () => {
    const plainFail = row(50652, "ChecksClean", "fail", { message: "dirty" });
    expect(await depOf(7, [CUT_TIMEOUT, CUT_NOT_TRUSTED, plainFail])).toBe("diverged");
  });

  test("R637 r8 (review M2): the measured text shows HangsDirty first, then ChecksClean", async () => {
    const m = (await probe()).facts.find((f) => f.fact === DEP)?.measured ?? "";
    expect(m.indexOf("HangsDirty=")).toBeGreaterThan(-1);
    expect(m.indexOf("HangsDirty=")).toBeLessThan(m.indexOf("ChecksClean="));
    expect(m).toContain('"Test exceeded 3s timeout."');
  });

  test("an unmeasurable defect fact does not refuse but is warned BY NAME (r6)", async () => {
    const none = () => ({ exitCode: 6, stdout: "" });
    const r = await probe({ "cu50660-n3": none, cu50660: none });
    expect(r.facts.find((f) => f.fact === "sleep-is-noop")?.verdict).toBe("unmeasurable");
    expect(v3ContractRefusals(r).join("\n")).not.toMatch(/sleep-is-noop/);
    expect(v3DefectWarnings(r).join("\n")).toMatch(
      /al-runner-v3-defect-unmeasurable: sleep-is-noop/,
    );
    // alpha.2 as measured warns nothing.
    expect(v3DefectWarnings(await probe())).toEqual([]);
  });

  test("sleep-is-noop diverges (and refuses) when Sleep is fast but the clock did not advance", async () => {
    const fastNoClock = () => ({
      exitCode: 1,
      stdout: doc([
        row(50660, "ShortSleep", "pass"),
        row(50660, "LongSleepA", "pass"),
        row(50660, "LongSleepB", "pass"),
        row(50660, "LongSleepThenAssert", "fail", { message: "after sleep 3" }),
        row(50660, "SleeperDoubles", "pass"),
      ]),
    });
    const r = await probe({ "cu50660-n3": fastNoClock, cu50660: fastNoClock });
    expect(r.facts.find((f) => f.fact === "sleep-is-noop")?.verdict).toBe("diverged");
    expect(v3ContractRefusals(r).join("\n")).toMatch(/DIVERGED — sleep-is-noop/);
  });
});

describe("R639 (pre-commitment r9): leg C's BC readings", () => {
  const EDGE_TEXT =
    "There was an error while executing the HTTP request, the connecting endpoint violates security requirements. Make sure you are connecting to a valid endpoint.";
  const LATER_FAIL = row(50653, "LaterFails", "fail", { message: "later" });
  const http = (o: Parameters<typeof row>[3], status = "fail") => row(50653, "HttpGet", status, o);
  const at50653 = (exitCode: number, rows: unknown[]) =>
    probe({ cu50653: () => ({ exitCode, stdout: doc(rows) }) });
  const verdictOf = (r: V3ContractResult, name: string) =>
    r.facts.find((f) => f.fact === name)?.verdict;
  const RRS = "refusal-row-shape";

  test("P1: refusal-row-shape reads gone on BC's exact text, fail, exit 1; leg C held; no refusal", async () => {
    const r = await at50653(1, [http({ message: BC_HTTP_INTERNAL_TEXT }), LATER_FAIL]);
    expect(r.facts.find((f) => f.fact === RRS)).toMatchObject({ kind: "defect", verdict: "gone" });
    expect(classifyLegC(r.facts, V3_DEFECT_FACTS, V3_LEG_C_FACTS).outcome).toBe("held");
    expect(v3ContractRefusals(r)).toEqual([]);
  });

  test("P2 (text): BC's text changed by a trailing space, a cut, a suffix or its case is never gone: unlike-bc", async () => {
    for (const m of [
      `${BC_HTTP_INTERNAL_TEXT} `,
      BC_HTTP_INTERNAL_TEXT.slice(0, -1),
      `${BC_HTTP_INTERNAL_TEXT} more`,
      BC_HTTP_INTERNAL_TEXT.toLowerCase(),
    ]) {
      const r = await at50653(1, [http({ message: m }), LATER_FAIL]);
      expect(verdictOf(r, RRS)).toBe("unlike-bc");
    }
  });

  test("P2 (fields): status error, notRun without the prefix, exit 7, a second HttpGet row, or the prefix with notRun false read diverged", async () => {
    const cases: Array<[number, unknown[]]> = [
      [1, [http({ message: BC_HTTP_INTERNAL_TEXT }, "error"), LATER_FAIL]],
      [7, [http({ message: BC_HTTP_INTERNAL_TEXT, notRun: true }, "error"), LATER_FAIL]],
      [7, [http({ message: BC_HTTP_INTERNAL_TEXT }), LATER_FAIL]],
      [1, [http({ message: BC_HTTP_INTERNAL_TEXT }), http({ message: BC_HTTP_INTERNAL_TEXT })]],
      [1, [http({ message: "NotRun: out-of-scope: an outbound HTTP request" }), LATER_FAIL]],
    ];
    for (const [exitCode, rows] of cases) {
      const r = await at50653(exitCode, rows);
      expect(verdictOf(r, RRS)).toBe("diverged");
      expect(v3ContractRefusals(r, { candidate: true }).join("\n")).toMatch(
        /DIVERGED — refusal-row-shape/,
      );
      expect(classifyLegC(r.facts, V3_DEFECT_FACTS, V3_LEG_C_FACTS).outcome).toBe("gate-fail");
    }
  });

  test("P3: alpha.2's measured row (exit 7, notRun, the prefix) is defect-present, a pass; at exit 1 it diverges", async () => {
    const r = await probe();
    expect(verdictOf(r, RRS)).toBe("defect-present");
    expect(classifyLegC(r.facts, V3_DEFECT_FACTS, V3_LEG_C_FACTS).outcome).toBe("pass");
    const refused = http({ notRun: true, message: "NotRun: out-of-scope: x" }, "error");
    expect(verdictOf(await at50653(1, [refused, LATER_FAIL]), RRS)).toBe("defect-present");
    expect(
      verdictOf(
        await at50653(1, [refused, row(50653, "LaterFails", "error", { notRun: true })]),
        RRS,
      ),
    ).toBe("diverged");
  });

  const at50654 = (exitCode: number, rows: unknown[] | "none") =>
    probe({
      cu50654: () => ({ exitCode, stdout: rows === "none" ? "" : doc(rows) }),
    });
  const PUB_FAIL = row(50654, "HttpGetPublic", "fail", { message: EDGE_TEXT });
  const PUB_LATER_FAIL = row(50654, "LaterFails", "fail", { message: "later" });
  const PUB = "refusal-row-shape-public";

  test("P5: refusal-row-shape-public matches a refusal row with the implied exit (7 cascaded, 1 with a plain later fail)", async () => {
    expect((await probe()).facts.find((f) => f.fact === PUB)).toMatchObject({
      kind: "contract",
      verdict: "matches",
    });
    expect(verdictOf(await at50654(1, [PUBLIC_REFUSED, PUB_LATER_FAIL]), PUB)).toBe("matches");
  });

  test("P5: a plain fail (M9 drift), exit 1 with only notRun rows, and no document diverge", async () => {
    expect(verdictOf(await at50654(1, [PUB_FAIL, PUB_LATER_FAIL]), PUB)).toBe("diverged");
    expect(verdictOf(await at50654(1, PUBLIC_ROWS), PUB)).toBe("diverged");
    const r = await at50654(1, "none");
    expect(verdictOf(r, PUB)).toBe("diverged");
    expect(v3ContractRefusals(r, { candidate: true }).join("\n")).toMatch(
      /DIVERGED — refusal-row-shape-public/,
    );
  });

  test("P6: refusal-cascade is gone only beside a refused HttpGetPublic; a vacuous plain-fail sibling is unmeasurable", async () => {
    expect(verdictOf(await probe(), "refusal-cascade")).toBe("defect-present");
    expect(verdictOf(await at50654(1, [PUBLIC_REFUSED, PUB_LATER_FAIL]), "refusal-cascade")).toBe(
      "gone",
    );
    expect(verdictOf(await at50654(1, [PUB_FAIL, PUB_LATER_FAIL]), "refusal-cascade")).toBe(
      "unmeasurable",
    );
    const other = row(50654, "LaterFails", "fail", { message: "later!" });
    expect(verdictOf(await at50654(1, [PUBLIC_REFUSED, other]), "refusal-cascade")).toBe(
      "diverged",
    );
  });

  const at50657 = (exitCode: number, rows: unknown[]) =>
    probe({ cu50657: () => ({ exitCode, stdout: doc(rows) }) });
  const CUC = "commit-under-test-isolation";

  test("P7: commit-under-test-isolation: the refusal prefix with notRun false diverges; a plain pass is gone", async () => {
    expect(verdictOf(await probe(), CUC)).toBe("defect-present");
    const dressed = row(50657, "CommitCall", "fail", { message: "NotRun: out-of-scope: Commit" });
    const r = await at50657(1, [dressed]);
    expect(verdictOf(r, CUC)).toBe("diverged");
    expect(v3ContractRefusals(r).join("\n")).toMatch(/DIVERGED — commit-under-test-isolation/);
    expect(verdictOf(await at50657(0, [row(50657, "CommitCall", "pass")]), CUC)).toBe("gone");
    expect(verdictOf(await at50657(0, []), CUC)).toBe("unmeasurable");
  });

  // R672 (plan 2026-10-23-r672-v3-refusal-prefix.md §1a, S9 and S10): a one-word-prefixed refusal
  // written as a plain fail reads as the unprefixed one does, never unlike-bc or gone.
  // R675: the marker after ANY text (a spaced or `::` prefix, an Assert quoting it) reads diverged.
  for (const p of [
    "Error: ",
    "Microsoft.Dynamics.Nav.Types.Exceptions.NavNCLAssertErrorException: ",
    "Runtime error: ",
    "a::b: ",
    "Assert.AreEqual failed. Expected: ",
  ]) {
    test(`R672/R675 S9: refusal-row-shape reads a fail holding the marker after "${p}" as diverged`, async () => {
      const m = `${p}NotRun: out-of-scope: an outbound HTTP request`;
      expect(verdictOf(await at50653(1, [http({ message: m }), LATER_FAIL]), RRS)).toBe("diverged");
    });
    test(`R672/R675 S10: commit-under-test-isolation reads a fail holding the marker after "${p}" as diverged`, async () => {
      const dressed = row(50657, "CommitCall", "fail", {
        message: `${p}NotRun: out-of-scope: Commit`,
      });
      expect(verdictOf(await at50657(1, [dressed]), CUC)).toBe("diverged");
    });
  }
  test("R675 S9/S10: a fail WITHOUT the marker keeps its reading (unlike-bc, gone)", async () => {
    const other = "out-of-scope: an outbound HTTP request";
    expect(verdictOf(await at50653(1, [http({ message: other }), LATER_FAIL]), RRS)).toBe(
      "unlike-bc",
    );
    const plain = row(50657, "CommitCall", "fail", { message: "boom" });
    expect(verdictOf(await at50657(1, [plain]), CUC)).toBe("gone");
  });

  const at50655 = (exitCode: number, rows: unknown[]) =>
    probe({ cu50655: () => ({ exitCode, stdout: doc(rows) }) });
  const DUP = "duplicate-key-insert-raises";
  const DUP_REFUSED = row(50655, "DuplicateNamedKey", "error", {
    notRun: true,
    message:
      "NotRun: out-of-scope: the test ends while the error of a duplicate-key Insert into table Probe Row is deferred",
  });

  test("P8: the duplicate key, one row per reading (branch F)", async () => {
    expect(verdictOf(await probe(), DUP)).toBe("defect-present");
    const fail = (message: string) => row(50655, "DuplicateNamedKey", "fail", { message });
    expect(verdictOf(await at50655(1, [fail(BC_END_OF_TEST_TEXT)]), DUP)).toBe("gone");
    expect(verdictOf(await at50655(7, [DUP_REFUSED]), DUP)).toBe("refused");
    expect(verdictOf(await at50655(1, [fail("already exists")]), DUP)).toBe("diverged");
    const plainError = row(50655, "DuplicateNamedKey", "error", {
      message: "duplicate-key Insert",
    });
    expect(verdictOf(await at50655(1, [plainError]), DUP)).toBe("diverged");
    const otherRefusal = { ...DUP_REFUSED, message: "NotRun: out-of-scope: something else" };
    expect(verdictOf(await at50655(7, [otherRefusal]), DUP)).toBe("diverged");
    expect(verdictOf(await at50655(0, []), DUP)).toBe("unmeasurable");
  });

  test("P9: refused is held in leg C, never gone, only warned in a session", async () => {
    const r = await at50655(7, [DUP_REFUSED]);
    const c = classifyLegC(r.facts, V3_DEFECT_FACTS, V3_LEG_C_FACTS);
    expect(c.outcome).toBe("held");
    expect(c.lines.join("\n")).toMatch(
      /held: duplicate-key-insert-raises: defect-present -> refused \(v3 declines; not BC's reading; re-pre-commit\)/,
    );
    expect(v3DefectsGone(r)).toEqual([]);
    expect(v3DefectWarnings(r).join("\n")).toMatch(
      /al-runner-v3-defect-refused: duplicate-key-insert-raises/,
    );
    expect(v3ContractRefusals(r)).toEqual([]);
  });

  test("P9 (M-g): refused on a CONTRACT fact or a WARN fact is gate-fail", () => {
    const facts = [{ fact: "version", verdict: "refused" }];
    expect(classifyLegC(facts, [], 1, []).outcome).toBe("gate-fail");
    expect(classifyLegC([{ fact: "w", verdict: "refused" }], [], 1, ["w"]).outcome).toBe(
      "gate-fail",
    );
  });

  test("P10 (R590, r13): 28 facts, 9 defect, 18 contract, 1 warn; the old count of 27 is gate-fail", async () => {
    const r = await probe();
    const kinds = (k: string) => r.facts.filter((f) => f.kind === k).length;
    expect([r.facts.length, kinds("defect"), kinds("contract"), kinds("warn")]).toEqual([
      28, 9, 18, 1,
    ]);
    expect(V3_LEG_C_FACTS).toBe(28);
    expect(classifyLegC(r.facts, V3_DEFECT_FACTS, 27).outcome).toBe("gate-fail");
    expect(
      r.facts
        .filter((f) => f.kind === "defect")
        .map((f) => f.fact)
        .sort(),
    ).toEqual([...V3_DEFECT_FACTS].sort());
    expect(classifyLegC(r.facts, V3_DEFECT_FACTS, 25).outcome).toBe("gate-fail");
  });

  test("P11 (F4): measured is kept whole in the fact and in leg C's printed line", async () => {
    const long = `${"x".repeat(700)}END`;
    const r = await at50655(1, [row(50655, "DuplicateNamedKey", "fail", { message: long })]);
    const f = r.facts.find((x) => x.fact === DUP);
    expect(f?.measured).toContain(long);
    expect(legCFactLine({ fact: "x", verdict: "v", measured: "m".repeat(250) })).toBe(
      `  C: x = v | ${"m".repeat(250)}`,
    );
  });

  const EDGE_ROWS = [http({ message: EDGE_TEXT }), LATER_FAIL];

  test("P12: edge's row is unlike-bc: gate-fail in leg C (#5700); a CANDIDATE session warns and runs", async () => {
    const r = await at50653(1, EDGE_ROWS);
    expect(verdictOf(r, RRS)).toBe("unlike-bc");
    const c = classifyLegC(r.facts, V3_DEFECT_FACTS, V3_LEG_C_FACTS);
    expect(c.outcome).toBe("gate-fail");
    expect(c.lines.join("\n")).toMatch(
      /gate-fail: refusal-row-shape: unlike-bc \(v3 fails as BC does, with another text; #5700\)/,
    );
    expect(v3ContractRefusals(r, { candidate: true })).toEqual([]);
    expect(v3DefectWarnings(r, { candidate: true }).join("\n")).toMatch(
      /al-runner-v3-defect-unlike-bc: refusal-row-shape/,
    );
  });

  test("P13: the same row refuses a NORMAL session, naming the fact, with no warning in its place", async () => {
    const r = await at50653(1, EDGE_ROWS);
    expect(v3ContractRefusals(r).join("\n")).toMatch(/UNLIKE-BC — refusal-row-shape/);
    expect(v3DefectWarnings(r).join("\n")).not.toMatch(/unlike-bc/);
  });
});

describe("R590 dependency-skip-line: v3 says when it leaves a dependency out", () => {
  const F = "dependency-skip-line";
  const runs =
    (stderr: string, exitCode = 0) =>
    () => ({
      exitCode,
      stdout: doc([row(50662, "Runs", "pass")]),
      stderr,
    });

  test("as R-537 measured on alpha.2 and edge: matches, a contract fact; the probe app declares the absent dependency", async () => {
    const r = await probe();
    expect(r.facts.find((f) => f.fact === F)).toMatchObject({
      kind: "contract",
      verdict: "matches",
    });
    expect(classifyLegC(r.facts, V3_DEFECT_FACTS, V3_LEG_C_FACTS).outcome).toBe("pass");
  });

  for (const [why, stderr] of [
    ["no line (a build that logs it only with --verbose)", "alrunner 3.0.0-alpha.2 (91253f2d6)\n"],
    ["a reworded line", "dependency missing: dependency `LethAL R590 Absent` by LethAL\n"],
    [
      "the words mid-line",
      "warning: dependency skipped: dependency `LethAL R590 Absent` by LethAL\n",
    ],
    ["a skip line for another app", "dependency skipped: dependency `Other` by X\n"],
  ] as const) {
    test(`${why}: diverged, refuses a session, gate-fail`, async () => {
      const r = await probe({ cu50662: runs(stderr) });
      expect(r.facts.find((f) => f.fact === F)?.verdict).toBe("diverged");
      expect(v3ContractRefusals(r).join("\n")).toMatch(/DIVERGED — dependency-skip-line/);
      expect(classifyLegC(r.facts, V3_DEFECT_FACTS, V3_LEG_C_FACTS).outcome).toBe("gate-fail");
    });
  }

  test("a call that did not run: unmeasurable, never matches", async () => {
    const r = await probe({ cu50662: runs("spawn failed", -1) });
    expect(r.facts.find((f) => f.fact === F)?.verdict).toBe("unmeasurable");
  });
});

describe("R667 message-has-no-type-prefix: v3's failure message carries no `<Type>: ` prefix", () => {
  const MSG = "message-has-no-type-prefix";
  const PREFIXED = "NavNCLDialogException: R667 text";
  const mainWith = (fails: ReturnType<typeof row>) => () => ({
    exitCode: 1,
    stdout: doc([
      row(50650, "Passes", "pass"),
      fails,
      row(50650, "Space Step", "pass"),
      row(50650, "PersistA", "pass"),
      row(50650, "PersistB", "fail", { message: "rows=0 counter=1" }),
      row(50650, "ArmIs", "fail", { message: "arm=none" }),
      row(50650, "CoversOnlyA", "pass"),
    ]),
    stderr: `target: BC ${BC}, runtime 16.0\n`,
  });

  test("alpha.2 and edge as R657 measured: matches, a contract fact; the Assert call gets --dep Library Assert", async () => {
    const calls: string[][] = [];
    const base = fakeV3();
    const r = await runV3ContractProbe({
      alRunnerPath: "/fake/alrunner",
      expectedVersion: VERSION,
      packagesDir: "/fake/deps",
      bcVersion: BC,
      alcPath: "/fake/alc",
      alcIo: fakeAlcIo,
      tasksetPath: "/usr/bin/taskset",
      startBurner: () => ({ kill: () => {} }),
      spawn: async (argv, o) => {
        calls.push([...argv]);
        return base(argv, o);
      },
      serveSpawn: fakeServe().spawn,
      libraryAssertApp: LIBRARY_ASSERT,
    });
    expect(r.facts.find((f) => f.fact === MSG)).toMatchObject({
      kind: "contract",
      verdict: "matches",
    });
    const a = calls.find((c) => c.includes("50661")) ?? [];
    expect(a[a.indexOf("--dep") + 1]).toBe(LIBRARY_ASSERT);
    expect(classifyLegC(r.facts, V3_DEFECT_FACTS, V3_LEG_C_FACTS).outcome).toBe("pass");
  });

  test("a prefixed Assert row is broken: diverged, refuses, gate-fail", async () => {
    const r = await probe({
      cu50661: () => ({
        exitCode: 1,
        stdout: doc([row(50661, "AssertAreEqual", "fail", { message: PREFIXED })]),
      }),
    });
    expect(r.facts.find((f) => f.fact === MSG)?.verdict).toBe("diverged");
    expect(v3ContractRefusals(r).join("\n")).toMatch(/DIVERGED — message-has-no-type-prefix/);
    expect(classifyLegC(r.facts, V3_DEFECT_FACTS, V3_LEG_C_FACTS).outcome).toBe("gate-fail");
  });

  // R675: the fact reads the exact expected start (`boom 5`), so ANY text before it diverges.
  for (const p of [
    "Runtime error: ",
    "al_runtime::Error: ",
    " ",
    "[x] ",
    "A: B: ",
    "Error: ",
    "X.Y: ",
    "SomeException: ",
  ]) {
    const message = `${p}boom 5`;
    test(`R675: Fails "${message}" reads diverged, names the prefix, refuses a session with the reason`, async () => {
      const r = await probe({ cu50650: mainWith(row(50650, "Fails", "fail", { message })) });
      const f = r.facts.find((x) => x.fact === MSG);
      expect(f?.verdict).toBe("diverged");
      expect(f?.measured.startsWith(`prefix ${JSON.stringify(p)}; Fails `)).toBe(true);
      expect(classifyLegC(r.facts, V3_DEFECT_FACTS, V3_LEG_C_FACTS).outcome).toBe("gate-fail");
      const text = v3ContractRefusals(r).join("\n");
      expect(text).toMatch(/DIVERGED — message-has-no-type-prefix/);
      expect(text).toContain(`\n    why: ${MESSAGE_PREFIX_REASON}\n`);
    });
  }
  test("R675 (nit A): a Fails text without the expected start reads diverged as reworded, not prefix", async () => {
    for (const message of ["Boom 5", "Error: Boom 5", "boom 6"]) {
      const r = await probe({ cu50650: mainWith(row(50650, "Fails", "fail", { message })) });
      const f = r.facts.find((x) => x.fact === MSG);
      expect([message, f?.verdict, f?.measured.split("; Fails ")[0]]).toEqual([
        message,
        "diverged",
        `reworded ${JSON.stringify(message)}`,
      ]);
    }
  });
  test("R675 (build review): a present fail row with an EMPTY message reads diverged (reworded), never matches", async () => {
    const fails = await probe({ cu50650: mainWith(row(50650, "Fails", "fail", { message: "" })) });
    const f = fails.facts.find((x) => x.fact === MSG);
    expect([f?.verdict, f?.measured.split("; Fails ")[0]]).toEqual(["diverged", 'reworded ""']);
    const asserted = await probe({
      cu50661: () => ({
        exitCode: 1,
        stdout: doc([row(50661, "AssertAreEqual", "fail", { message: "" })]),
      }),
    });
    const a = asserted.facts.find((x) => x.fact === MSG);
    expect([a?.verdict, a?.measured.split("; Fails ")[0]]).toEqual(["diverged", 'reworded ""']);
  });
  test("R675: an Assert text with text before `Assert.AreEqual failed.` reads diverged, naming the prefix", async () => {
    const r = await probe({
      cu50661: () => ({
        exitCode: 1,
        stdout: doc([
          row(50661, "AssertAreEqual", "fail", {
            message:
              "Runtime error: Assert.AreEqual failed. Expected:<1> (Integer). Actual:<2> (Integer). R667 values differ.",
          }),
        ]),
      }),
    });
    const f = r.facts.find((x) => x.fact === MSG);
    expect(f?.verdict).toBe("diverged");
    expect(f?.measured.startsWith('prefix "Runtime error: "; Fails "boom 5"; ')).toBe(true);
    expect(classifyLegC(r.facts, V3_DEFECT_FACTS, V3_LEG_C_FACTS).outcome).toBe("gate-fail");
  });
  test("R672/R675: today's two probe texts (boom 5, an Assert.AreEqual text) read matches", async () => {
    // The default fake writes R657's measured texts (`boom 5`, `Assert.AreEqual failed. Expected:<1> ...`).
    const f = (await probe()).facts.find((x) => x.fact === MSG);
    expect(f?.verdict).toBe("matches");
    expect(f?.measured).toContain('Fails "boom 5"');
    expect(f?.measured).toContain("Assert.AreEqual failed. Expected:<1>");
    expect(f?.measured).not.toMatch(/^(prefix|reworded) /);
  });
  test("R675: boom 5 with an appended call stack still matches (startsWith, not equality)", async () => {
    const r = await probe({
      cu50650: mainWith(row(50650, "Fails", "fail", { message: "boom 5\n   at Fails line 3" })),
    });
    expect(r.facts.find((x) => x.fact === MSG)?.verdict).toBe("matches");
  });

  test("a prefixed plain Error() row (Fails) is broken: diverged, gate-fail", async () => {
    const r = await probe({
      cu50650: mainWith(row(50650, "Fails", "fail", { message: PREFIXED })),
    });
    expect(r.facts.find((f) => f.fact === MSG)?.verdict).toBe("diverged");
    expect(classifyLegC(r.facts, V3_DEFECT_FACTS, V3_LEG_C_FACTS).outcome).toBe("gate-fail");
  });

  test("a row that is not a plain fail (a refusal, or no row) is unmeasurable, never matches", async () => {
    const refused = await probe({
      cu50661: () => ({
        exitCode: 7,
        stdout: doc([
          row(50661, "AssertAreEqual", "error", {
            notRun: true,
            message: "NotRun: out-of-scope: x",
          }),
        ]),
      }),
    });
    expect(refused.facts.find((f) => f.fact === MSG)?.verdict).toBe("unmeasurable");
    const noFails = await probe({ cu50650: mainWith(row(50650, "Other", "pass")) });
    expect(noFails.facts.find((f) => f.fact === MSG)?.verdict).toBe("unmeasurable");
  });

  test("leg C without the Library Assert app is unmeasurable (infra-fail), never a silent matches", async () => {
    const r = await runV3ContractProbe({
      alRunnerPath: "/fake/alrunner",
      expectedVersion: VERSION,
      packagesDir: "/fake/deps",
      bcVersion: BC,
      alcPath: "/fake/alc",
      alcIo: fakeAlcIo,
      tasksetPath: "/usr/bin/taskset",
      startBurner: () => ({ kill: () => {} }),
      spawn: fakeV3(),
      serveSpawn: fakeServe().spawn,
    });
    expect(r.facts.find((f) => f.fact === MSG)?.verdict).toBe("unmeasurable");
    expect(classifyLegC(r.facts, V3_DEFECT_FACTS, V3_LEG_C_FACTS).outcome).toBe("infra-fail");
  });

  test("a SESSION reads Fails only (the Assert half is gate-only) and still refuses a prefix there", async () => {
    const calls: string[] = [];
    const base = fakeV3();
    const run = (fails: ReturnType<typeof row>) =>
      runV3ContractProbe({
        alRunnerPath: "/fake/alrunner",
        expectedVersion: VERSION,
        packagesDir: "/fake/deps",
        bcVersion: BC,
        alcPath: "/fake/alc",
        alcIo: fakeAlcIo,
        spawn: async (argv, o) => {
          calls.push(argv.join(" "));
          const k = argv.join(" ");
          return k.includes("--codeunit 50650") &&
            !k.includes("--define") &&
            !k.includes("/broken/") &&
            !k.includes("tests-pinned")
            ? mainWith(fails)()
            : base(argv, o);
        },
        gateOnlyTrusted: "the gated build's leg C at 5eb544ef",
      });
    const ok = await run(row(50650, "Fails", "fail", { message: "boom 5" }));
    const f = ok.facts.find((x) => x.fact === MSG);
    expect(f?.verdict).toBe("matches");
    // Review r1: never "trusted from" a leg C that, before r12, did not read this half.
    expect(f?.measured).toBe(
      'Fails "boom 5"; Assert half not re-measured in a session (gate-only); leg C reads it only from r12 on, so a .gated recorded before r12 never read it (the gated build\'s leg C at 5eb544ef)',
    );
    // (This fake main call writes no coverage, so only per-test-coverage refuses here.)
    expect(v3ContractRefusals(ok).join("\n")).not.toContain(MSG);
    expect(calls.some((c) => c.includes("--codeunit 50661"))).toBe(false);
    // A prefixed plain Error() (any shape, R675), and a prefixed refusal written as a plain fail:
    // each refuses the session, naming the reason.
    for (const message of [
      PREFIXED,
      "SomeException: NotRun: out-of-scope: an outbound HTTP request",
      "Runtime error: boom 5",
      "al_runtime::Error: boom 5",
    ]) {
      const bad = await run(row(50650, "Fails", "fail", { message }));
      const text = v3ContractRefusals(bad).join("\n");
      expect(text).toMatch(/DIVERGED — message-has-no-type-prefix/);
      expect(text).toContain(`\n    why: ${MESSAGE_PREFIX_REASON}\n`);
    }
  });

  test("the refusal's reason text is pinned", () => {
    expect(MESSAGE_PREFIX_REASON).toBe(
      "text before, or in place of, the expected start of v3's failure messages (a `<Type>:` prefix of any shape) would turn v3's timeouts into errors (`V3_TIMEOUT_MESSAGE` is anchored), close the serve daemon on every refusal (R612's keep list is anchored), and skew the R553 assertion screen. K1(a) and the serve-keep rule read v3's refusal marker anywhere in a message (R675), so a prefix cannot turn a refusal into a kill; the session still refuses, because v3 no longer writes what was measured",
    );
  });
});

describe("r6 classifySleep", () => {
  const rows = (ltaStatus: string, o: Parameters<typeof row>[3] = {}) =>
    [
      row(50660, "ShortSleep", "pass"),
      row(50660, "LongSleepA", "pass"),
      row(50660, "LongSleepB", "pass"),
      row(50660, "LongSleepThenAssert", ltaStatus, o),
      row(50660, "SleeperDoubles", "pass"),
    ] as unknown as V3Row[];
  test("instant and the clock advanced: defect-present", () => {
    expect(classifySleep({ rows: rows("pass"), wallMs: 30 })).toBe("defect-present");
  });
  test("a Sleep test stopped as a timeout row (upstream's proposed #5605 fix): gone", () => {
    expect(
      classifySleep({
        rows: rows("error", { notRun: true, message: "Test exceeded 3s timeout.", durationMs: 0 }),
        wallMs: 40,
      }),
    ).toBe("gone");
  });
  test("a Sleep test taking its real time: gone", () => {
    expect(classifySleep({ rows: rows("pass", { durationMs: 600000 }), wallMs: 600100 })).toBe(
      "gone",
    );
  });
  test("instant but the clock not advanced: diverged", () => {
    expect(classifySleep({ rows: rows("fail", { message: "after sleep 3" }), wallMs: 30 })).toBe(
      "diverged",
    );
  });
  test("a slow call with instant rows: diverged, never defect-present", () => {
    expect(classifySleep({ rows: rows("pass"), wallMs: 5000 })).toBe("diverged");
  });
  test("no document: unmeasurable", () => {
    expect(classifySleep({ rows: undefined, wallMs: 30 })).toBe("unmeasurable");
  });

  test("M1: a SESSION trusts the gated build's record: timeout-is-cpu is neither run nor refused on", async () => {
    const calls: string[] = [];
    const base = fakeV3();
    const r = await runV3ContractProbe({
      alRunnerPath: "/fake/alrunner",
      expectedVersion: VERSION,
      packagesDir: "/fake/deps",
      bcVersion: BC,
      alcPath: "/fake/alc",
      alcIo: fakeAlcIo,
      tasksetPath: "/usr/bin/taskset",
      startBurner: () => {
        throw new Error("a session must not start the burner");
      },
      spawn: async (argv, o) => {
        calls.push(argv.join(" "));
        return base(argv, o);
      },
      gateOnlyTrusted: "the gated build's leg C at 5eb544ef",
    });
    expect(
      calls.some((c) => c.includes("--codeunit 50656") || c.includes("--codeunit 50658")),
    ).toBe(false);
    const f = r.facts.find((x) => x.fact === "timeout-is-cpu");
    expect(f?.measured).toMatch(
      /not re-measured in a session: trusted from the gated build's leg C at 5eb544ef/,
    );
    expect(v3ContractRefusals(r)).toEqual([]);
  });

  test("M1, other direction: without the trust (the gate's leg C) the burns run", async () => {
    const calls: string[] = [];
    const base = fakeV3();
    const r = await runV3ContractProbe({
      alRunnerPath: "/fake/alrunner",
      expectedVersion: VERSION,
      packagesDir: "/fake/deps",
      bcVersion: BC,
      alcPath: "/fake/alc",
      alcIo: fakeAlcIo,
      tasksetPath: "/usr/bin/taskset",
      startBurner: () => ({ kill: () => {} }),
      spawn: async (argv, o) => {
        calls.push(argv.join(" "));
        return base(argv, o);
      },
    });
    expect(calls.some((c) => c.includes("--codeunit 50656"))).toBe(true);
    expect(r.facts.find((x) => x.fact === "timeout-is-cpu")?.verdict).toBe("matches");
  });

  test("no taskset leaves timeout-is-cpu unmeasurable, which refuses (a contract fact)", async () => {
    const r = await runV3ContractProbe({
      alRunnerPath: "/fake/alrunner",
      expectedVersion: VERSION,
      packagesDir: "/fake/deps",
      bcVersion: BC,
      alcPath: "/fake/alc",
      alcIo: fakeAlcIo,
      spawn: fakeV3(),
    });
    expect(v3ContractRefusals(r).join("\n")).toMatch(/UNMEASURABLE — timeout-is-cpu/);
  });
});

describe("T18: the .gated pin", () => {
  let dir = "";
  afterEach(async () => {
    if (dir !== "") await rm(dir, { recursive: true, force: true });
  });
  const setup = async (gated?: object) => {
    dir = await mkdtemp(join(tmpdir(), "lethal-r586-pin-"));
    const bin = join(dir, "al-runner");
    await writeFile(bin, "binary bytes");
    if (gated !== undefined) await writeFile(join(dir, ".gated"), JSON.stringify(gated));
    return bin;
  };

  const COMMIT = "5eb544ef0aafeab402ac050e4a9e7481a8e67790";
  test("a matching .gated passes", async () => {
    const bin = await setup();
    await writeFile(
      join(dir, ".gated"),
      JSON.stringify({
        version: VERSION,
        binarySha256: await sha256OfFile(bin),
        lethalCommit: COMMIT,
      }),
    );
    expect((await checkGated(bin, VERSION)).lethalCommit).toBe(COMMIT);
  });

  test("G5: a .gated whose lethalCommit is not the full 40-character sha is refused by name", async () => {
    const bin = await setup();
    for (const lethalCommit of ["abcdef1", COMMIT.slice(0, 39), `${COMMIT}0`]) {
      await writeFile(
        join(dir, ".gated"),
        JSON.stringify({ version: VERSION, binarySha256: await sha256OfFile(bin), lethalCommit }),
      );
      await expect(checkGated(bin, VERSION)).rejects.toThrow(/has no lethalCommit/);
    }
  });

  test("no .gated, another sha256 or another version is refused", async () => {
    const bin = await setup();
    await expect(checkGated(bin, VERSION)).rejects.toBeInstanceOf(AlRunnerV3UngatedBuildError);
    await writeFile(
      join(dir, ".gated"),
      JSON.stringify({ version: VERSION, binarySha256: "0".repeat(64), lethalCommit: COMMIT }),
    );
    await expect(checkGated(bin, VERSION)).rejects.toThrow(/sha256/);
    await writeFile(
      join(dir, ".gated"),
      JSON.stringify({
        version: "alrunner 3.0.0-alpha.3 (c893e3633)",
        binarySha256: await sha256OfFile(bin),
        lethalCommit: COMMIT,
      }),
    );
    await expect(checkGated(bin, VERSION)).rejects.toThrow(/pins/);
  });

  test("a candidate run reads no .gated, and a corrupt .gated is refused, never defaulted", async () => {
    const bin = await setup();
    expect((await checkGated(bin, VERSION, { candidate: true })).binarySha256).toBe(
      await sha256OfFile(bin),
    );
    expect(() => parseGated("{}", "x")).toThrow(AlRunnerV3UngatedBuildError);
    expect(() =>
      parseGated(`{"version":"v","binarySha256":"zz","lethalCommit":"${COMMIT}"}`, "x"),
    ).toThrow(/binarySha256/);
  });

  test("R612 M-2: .gated carries the gate's warn-fact readings; anything but a verdict is dropped", () => {
    const base = { version: "v", binarySha256: "a".repeat(64), lethalCommit: COMMIT };
    expect(
      parseGated(JSON.stringify({ ...base, warnFacts: { "serve-keep-reasons": "diverged" } }), "x")
        .warnFacts,
    ).toEqual({ "serve-keep-reasons": "diverged" });
    expect(
      parseGated(JSON.stringify({ ...base, warnFacts: { a: "matches", b: "pass", c: 1 } }), "x")
        .warnFacts,
    ).toEqual({ a: "matches" });
    expect("warnFacts" in parseGated(JSON.stringify(base), "x")).toBe(false);
  });
});
