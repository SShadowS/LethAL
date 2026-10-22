// R586 §8 and §12: the v3 contract probe against a fake v3 (and a fake alc), and the `.gated`
// pin (T18). Every refusal has a test per direction.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { V3_DEFECT_FACTS, V3_WARN_FACTS, classifyLegC } from "../itest/al-runner-v3-gate";
import type { ServerSpawnFn } from "../src/al-runner-server";
import type { V3Row } from "../src/al-runner-v3-backend";
import {
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
      cu50657: {
        exitCode: 7,
        stdout: doc([
          row(50657, "CommitCall", "error", {
            notRun: true,
            message: "NotRun: out-of-scope: Commit",
          }),
        ]),
      },
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
    expect(classifyLegC(r.facts, V3_DEFECT_FACTS, 24)).toEqual({ outcome: "pass", lines: [] });
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
      const c = classifyLegC(r.facts, V3_DEFECT_FACTS, 24);
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
    const c = classifyLegC(r.facts, V3_DEFECT_FACTS, 24);
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
    expect(classifyLegC(r.facts, V3_DEFECT_FACTS, 24, []).outcome).toBe("gate-fail");
  });

  test("a session (gateOnlyTrusted) never starts serve; the fact is trusted from the gate", async () => {
    const s = fakeServe();
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
      serveSpawn: s.spawn,
      gateOnlyTrusted: "the gated build's leg C at 5eb544ef",
    });
    expect(s.argvs).toEqual([]);
    expect(r.facts.find((x) => x.fact === "serve-keep-reasons")).toMatchObject({
      kind: "warn",
      verdict: "matches",
    });
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
        "per-test-coverage",
        "codeunit-runs-whole",
        "codeunit-row-equals-exact-row",
        "none-selected-exit",
        "quoted-name-unselectable",
        "timeout-classified",
        "timeout-is-cpu",
        "refusal-row-shape",
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
        stdout: doc([row(50655, "DuplicateNamedKey", "fail", { message: "already exists" })]),
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
    expect(V3_DEFECT_FACTS.length).toBe(8);
    // alpha.2 as measured: exit 6, no document.
    const before = await probe();
    const f0 = before.facts.find((f) => f.fact === "none-selected-exit");
    expect(f0).toMatchObject({ kind: "defect", verdict: "defect-present" });
    expect(classifyLegC(before.facts, V3_DEFECT_FACTS, 24).outcome).toBe("pass");
    // alpha.4 (#5622): exit 6 with a document of 0 rows.
    const r = await probe({ cu0: () => ({ exitCode: 6, stdout: doc([]) }) });
    expect(r.facts.find((f) => f.fact === "none-selected-exit")?.verdict).toBe("gone");
    expect(v3ContractRefusals(r)).toEqual([]);
    expect(v3DefectsGone(r).join("\n")).toMatch(/defect-gone: none-selected-exit/);
    expect(classifyLegC(r.facts, V3_DEFECT_FACTS, 24).outcome).toBe("held");
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
      expect(classifyLegC(r.facts, V3_DEFECT_FACTS, 24).outcome).toBe("gate-fail");
    }
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
});
