// R586 §8 and §12: the v3 contract probe against a fake v3 (and a fake alc), and the `.gated`
// pin (T18). Every refusal has a test per direction.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
  BC_HTTP_HUB_TEXT,
  BC_HTTP_INTERNAL_TEXT,
  BURN_BUSY_LOOPS,
  BURN_GUARD_MS,
  BURN_HUGE,
  BURN_RELATIVE_FACTOR,
  BURN_TRIES,
  MESSAGE_PREFIX_REASON,
  SERVE_CASES,
  SERVE_TESTS_AL,
  STOP_GROUPS_FACT,
  STOP_GROUPS_REQUESTS,
  type StopAnswer,
  type V3ContractResult,
  type V3KeepApp,
  type V3ProbeEnv,
  V3_CAPABILITY_FACTS,
  V3_CARRY_FACT,
  V3_KEEP_APP_FAMILIES,
  V3_KEEP_CASES,
  burnerArgv,
  classifySleep,
  judgeStopGroups,
  leastBusyCore,
  parseAllowedCores,
  runV3ContractProbe as runV3ContractProbeRaw,
  v3ContractRefusals,
  v3DefectWarnings,
  v3DefectsGone,
} from "../src/al-runner-v3-contract";

/**
 * PR-363: a fake manifest of `V3_KEEP_APP_FAMILIES` family apps, each with one case (`stream-never-created`, whose
 * refusal text is one short line). `fakeServe` answers a request for one of these dirs with that case's row.
 */
const FAKE_KEEP_DIR = "/fake/keep";
const KEEP_CASE = { entry: "stream-never-created", name: "Codeunit51001.Cell" } as const;
const KEEP_TEXT = "NotRun: out-of-scope: use of an OutStream that was never created";
// Build review L1: the manifest must hold exactly V3_KEEP_CASES cases, so fam0 carries the rest (one per family otherwise).
const KEEP_APPS: readonly V3KeepApp[] = Array.from({ length: V3_KEEP_APP_FAMILIES }, (_, i) => ({
  family: `fam${i}`,
  dir: `${FAKE_KEEP_DIR}/fam${i}`,
  cases:
    i === 0
      ? Array.from({ length: V3_KEEP_CASES - (V3_KEEP_APP_FAMILIES - 1) }, (_, k) => ({
          entry: KEEP_CASE.entry,
          name: `Codeunit${51001 + k}.Cell`,
        }))
      : [KEEP_CASE],
}));
/** PR-363: the default answer to a family app's request: each of its cases a kept refusal. */
const keptRows = (dir: string) =>
  (KEEP_APPS.find((a) => a.dir === dir)?.cases ?? [KEEP_CASE]).map((c) => ({
    name: c.name,
    status: "error",
    notRun: true,
    message: KEEP_TEXT,
  }));
/** Every probe in this file gets the fake family apps unless it names its own (or, with the raw one, none). */
const runV3ContractProbe = (env: V3ProbeEnv) =>
  runV3ContractProbeRaw({ keepApps: KEEP_APPS, ...env });
import {
  AlRunnerV3UngatedBuildError,
  checkGated,
  parseGated,
  sha256OfFile,
} from "../src/al-runner-v3-pin";
import { baselineBatchingOffReason, carryWalkOffReason } from "../src/al-runner-v3-pins";
import { V3_PREDEFINED_CANDIDATES } from "../src/al-runner-v3-probe";
import { mergeChildEnv } from "../src/al-runner-v3-seed";
import type { ArtifactIo } from "../src/artifact";
import type { SpawnFn } from "../src/publisher";

const VERSION = "alrunner 3.0.0-alpha.2 (91253f2d6)";
const BC = "28.0.46665.47126";

type Over = Partial<
  Record<
    string,
    (
      argv: readonly string[],
    ) =>
      | { exitCode: number; stdout: string; stderr?: string; cpuMs?: number; wallMs?: number }
      | undefined
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
/** R693 r14b: the huge burn's row when v3 stopped it at the 2 s limit, after `durationMs`. */
const burnRow = (durationMs: number) =>
  row(50656, "CpuBurnLong", "error", {
    notRun: true,
    message: "Test exceeded 2s timeout.",
    durationMs,
  });
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
  let burnCalls = 0;
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
    if (key === "cu50656-shared-n2") burnCalls += 1;
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
      // R693 (r14b): call A (alone, stopped at about 2 s) then call B (beside 7 loops, stopped late).
      "cu50656-shared-n2": {
        exitCode: 7,
        stdout: doc([burnRow(burnCalls === 1 ? 2010 : 16000)]),
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

/** R1000: the cascade-existing-state texts, before (736fc7677) and after (847b1fa5a) the rewording. */
const CASCADE_736 = (t: string): string =>
  `NotRun: out-of-scope: an earlier test of this codeunit, ${t}, changed an isolated storage key or a number sequence that existed before it: what the rollback of TestIsolation = Function leaves of it is not measured (only a new key's IsolatedStorage.Set and a new NumberSequence.Insert are)`;
const SEQ_847 = `NotRun: out-of-scope: an earlier test of this codeunit, B_ChangesSeq, changed number sequence 'R1000SEQ' that existed before it: what the rollback of TestIsolation = Function leaves of it is not measured (only a new NumberSequence.Insert is)`;
const KEY_847 = `NotRun: out-of-scope: an earlier test of this codeunit, B_ChangesKey, changed isolated storage key 'R1000KEY' that existed before it: what the rollback of TestIsolation = Function leaves of it is not measured (only a new key's IsolatedStorage.Set is)`;

/** R998: the three kept families as edge-a184cfc79 words them (`/coord/handoff/R-998/probe/out/`). */
const RECREF = (m: string): string =>
  `NotRun: out-of-scope: RecordRef.${m} on a RecordRef that is not open: BC's error text, and whether Get(RecordId) opens the table of the RecordId, are not pinned (docs/probes-needed.md)`;
const R998_ROWS: Record<string, { status: string; notRun: boolean; message: string }> = {
  "Codeunit50677.Refuses": { status: "error", notRun: true, message: RECREF("FieldCount") },
  "Codeunit50678.Refuses": { status: "error", notRun: true, message: RECREF("FindSet") },
  "Codeunit50679.Refuses": { status: "error", notRun: true, message: RECREF("SetRecFilter") },
  "Codeunit50680.Refuses": { status: "error", notRun: true, message: RECREF("SetLoadFields") },
  "Codeunit50681.Refuses": {
    status: "error",
    notRun: true,
    message:
      "NotRun: out-of-scope: FieldRef.Class on a FieldRef that was never assigned: what BC does (an error, or a no-op) is not pinned (docs/probes-needed.md)",
  },
  "Codeunit50682.Refuses": {
    status: "error",
    notRun: true,
    message: "NotRun: out-of-scope: RecordRef.GetTable of an unassigned Variant",
  },
  // R1019 (coord PR-14): the manual-binding cascade as edge-5a58a0f16 words it (`/coord/handoff/PR-14/probe/`);
  // the failing test before it is a plain trusted fail.
  "Codeunit50685.A_BindThenFail": { status: "fail", notRun: false, message: "planted" },
  "Codeunit50685.B_BindAgain": {
    status: "error",
    notRun: true,
    message:
      "NotRun: out-of-scope: a test before this one in the codeunit did not pass (A_BindThenFail: failed (planted)) and left a manual event subscription bound that it would have unbound later: the bindings this test starts with are not BC's; this failure is not trusted: The binding of codeunit 50684 was unsuccessful. The codeunit has already been bound.",
  },
  // PR-18 lever 1: the FormatRegion family as edge-847b1fa5a and edge-5a58a0f16 word it (`/coord/handoff/PR-18/probe/`).
  "Codeunit50687.Refuses": {
    status: "error",
    notRun: true,
    message:
      "NotRun: out-of-scope: Format of a value (standard format 4) while CurrReport.FormatRegion is 'en-GB' is not pinned (docs/probes-needed.md)",
  },
  // PR-54: DO's File.DownloadFromStream refusal as edge-5a58a0f16 words it (`/coord/handoff/PR-54/`).
  "Codeunit50697.Refuses": {
    status: "error",
    notRun: true,
    message:
      "NotRun: out-of-scope: File.DownloadFromStream needs a client (a browser round trip), which a headless run has not",
  },
  // PR-53: the SetFilter-Boolean refusal as edge-5a58a0f16 words it (`/coord/handoff/PR-53/`).
  "Codeunit50696.Refuses": {
    status: "error",
    notRun: true,
    message:
      "NotRun: out-of-scope: SetFilter: a Boolean filter value under GlobalLanguage 1030 (the words of that language are not pinned)",
  },
  // PR-47: the GoToKey refusal as edge-5a58a0f16 words it (`/coord/handoff/PR-47/`).
  "Codeunit50694.Refuses": {
    status: "error",
    notRun: true,
    message:
      "NotRun: out-of-scope: GoToKey on a list that opened on the last row of its descending view, with more rows above the rows it holds than a window (not pinned)",
  },
  // R1043: the caption family as both builds word it (`/coord/handoff/PR-18/probe-caption/`).
  "Codeunit50689.Refuses": {
    status: "error",
    notRun: true,
    message:
      "NotRun: out-of-scope: the caption of a page with DataCaptionExpression and no source table (not pinned)",
  },
  // R1009 (coord PR-29): the stale-buffer refusal as edge-5a58a0f16 words it (`/coord/handoff/R1009-keep/probe/`).
  "Codeunit50690.Refuses": {
    status: "error",
    notRun: true,
    message:
      "NotRun: out-of-scope: a stale Serve Stale Row buffer from its own write, after a lock other than LockTable or a ReadIsolation read in the open transaction (not pinned)",
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
  // R808: the public-host test; alpha.2's wording.
  "Codeunit50674.HttpGetPublic": {
    status: "error",
    notRun: true,
    message:
      "NotRun: out-of-scope: an outbound HTTP request with no [HttpClientHandler] bound to the test: the runtime never opens a connection (ADR-027)",
  },
  // R1000 (coord R-989): the families added after R612, as edge-736fc7677 words them (R-989's probe).
  "Codeunit50675.C_UsesSeq": {
    status: "error",
    notRun: true,
    message: CASCADE_736("B_ChangesSeq"),
  },
  "Codeunit50676.C_UsesKey": {
    status: "error",
    notRun: true,
    message: CASCADE_736("B_ChangesKey"),
  },
  // R998 (coord R-998): the three kept families, as edge-a184cfc79 words them (R-998's probe).
  ...R998_ROWS,
};

type ServeRow = { status: string; notRun?: boolean; message?: string };

/** R808: today's wording of the http refusal (alpha.7, alpha.12; leg C `refusal-row-shape-public`). */
const HTTP_TODAY =
  "NotRun: out-of-scope: an outbound HTTP request that a test handler does not answer: the runtime never opens a connection (ADR-027). To run the test, bind an [HttpClientHandler] that answers the request, or set TestHttpRequestPolicy = BlockOutboundRequests on the test codeunit to get BC's error for it";

/** R705: a #5602-fixed build: http and cascade come back as plain trusted fails. */
const FIXED_ROWS: Record<string, ServeRow> = {
  ...SERVE_ROWS,
  "Codeunit50670.HttpGet": {
    status: "fail",
    notRun: false,
    message: "There was an error while executing the HTTP request, connection refused",
  },
  "Codeunit50672.LaterFails": { status: "fail", notRun: false, message: "later" },
};

/** R808: alpha.12's serve rows: localhost a plain fail, a public host today's refusal, commit a
 *  plain pass, and NO row for `Codeunit50673.Never` (since #5859). */
const { "Codeunit50673.Never": _noOnRunRow, ...FIXED_WITHOUT_NEVER } = FIXED_ROWS;
const TODAY_ROWS: Record<string, ServeRow> = {
  ...FIXED_WITHOUT_NEVER,
  "Codeunit50671.CommitCall": { status: "pass", notRun: false },
  "Codeunit50674.HttpGetPublic": { status: "error", notRun: true, message: HTTP_TODAY },
  // R1000: edge-847b1fa5a's per-kind cascade texts
  "Codeunit50675.C_UsesSeq": { status: "error", notRun: true, message: SEQ_847 },
  "Codeunit50676.C_UsesKey": { status: "error", notRun: true, message: KEY_847 },
};

/** PR-114a: what a request of a capability fact gets back: test rows and a summary, or an error line. */
type CapAnswer =
  | { tests: Record<string, unknown>[]; summary: Record<string, unknown> }
  | { error: string }
  /** M1: the request is never answered in time; its rows and summary arrive LATE, before the next answer. */
  | { hang: CapAnswer };

/** PR-114a: each capability folder's test codeunits `[id, methods]`, as the probe writes them. */
const CAP_APPS: Record<string, readonly (readonly [number, readonly string[]])[]> = {
  "batch-no-cross-singleinstance": [
    [50702, ["WritesState"]],
    [50703, ["SeesNoCounter", "SeesNoTemp"]],
    [50704, ["Spare"]],
  ],
  "batch-no-cross-library-global": [
    [50712, ["WritesLibraryGlobal"]],
    [50713, ["SeesFreshLibrary"]],
    [50714, ["Spare"]],
  ],
  "batch-no-cross-row": [
    [50722, ["WritesARealRow"]],
    [50723, ["SeesNoRealRow"]],
    [50724, ["Spare"]],
  ],
  "batch-no-cross-subscriber": [
    [50733, ["BindsASubscriber"]],
    [50734, ["SeesNoBoundSubscriber"]],
    [50735, ["Spare"]],
  ],
  "batch-onrun-excluded-no-carry": [
    [50741, ["WriterSeesOwnRow"]],
    [50742, ["ReaderSeesNoRow"]],
    [50743, ["OtherInsertsAndSeesOne"]],
    [50744, ["Spare"]],
  ],
  "batch-onrun-included-duplicates": [
    [50751, ["WriterSeesOwnRow"]],
    [50752, ["ReaderSeesNoRow"]],
    [50753, ["OtherInsertsAndSeesOne"]],
    [50754, ["Spare"]],
  ],
  "batch-lane-hint-only": [
    [50762, ["StoresFive"]],
    [50763, ["NeedsFive"]],
    [50764, ["Spare"]],
  ],
  "batch-lane-strict-reruns": [
    [50772, ["StoresFive"]],
    [50773, ["NeedsFive"]],
    [50774, ["Spare"]],
  ],
  // PR-340: the carry fact (outside V3_CAPABILITY_FACTS).
  "batch-sequential-carry": [
    [50782, ["LeavesFive"]],
    [50783, ["WantsZero"]],
    [50784, ["Spare"]],
  ],
};

/** The last part of a path, whether it uses `/` or `\` (the probe's scratch folders use the host's: backslashes on Windows). */
const folderName = (p: string): string => p.split(/[\\/]/).pop() ?? "";

/** PR-114a: is this serve request one of the capability facts' (a scratch folder named `batch-...`)? */
const isCapabilityRequest = (q: Record<string, unknown>): boolean =>
  Array.isArray(q.sourcePaths) && folderName(String(q.sourcePaths[0])).startsWith("batch-");

/** PR-342: is this serve request the stop-groups fact's? */
const isStopGroupsRequest = (q: Record<string, unknown>): boolean =>
  Array.isArray(q.sourcePaths) && folderName(String(q.sourcePaths[0])) === "stop-groups";

const capRow = (id: number, method: string, status = "pass", message?: string) => ({
  name: `Codeunit${id}.${method}`,
  status,
  ...(message !== undefined ? { message } : {}),
});

/** PR-114a: the answer an edge-4ebfe7913-like build gives a capability request (the probes' readings). */
function capabilityAnswer(fact: string, req: Record<string, unknown>): CapAnswer {
  const test = typeof req.test === "string" ? req.test : undefined;
  const gone = Array.isArray(req.excludeTests) ? (req.excludeTests as string[]) : [];
  const cus = (CAP_APPS[fact] ?? []).filter(
    ([id]) => (test === undefined || test === `Codeunit${id}.`) && !gone.includes(`Codeunit${id}.`),
  );
  const tests: Record<string, unknown>[] = [];
  const summary: Record<string, unknown> = {};
  const lane = fact.startsWith("batch-lane-");
  for (const [id, methods] of cus)
    for (const m of methods)
      tests.push(lane && m === "NeedsFive" ? capRow(id, m, "fail", "store is 0") : capRow(id, m));
  if (lane && req.strictOrder === true) {
    // strictOrder: the writer runs again, then the reader is re-run and passes.
    for (const [id, methods] of cus) for (const m of methods) tests.push(capRow(id, m));
  } else if (lane) {
    const reader = cus.find(([, ms]) => ms.includes("NeedsFive"));
    if (reader !== undefined)
      summary.orderHints = [
        {
          name: `Codeunit${reader[0]}.NeedsFive`,
          orderHint:
            'this test read global Stored of SingleInstance codeunit 50760 "Batch Lane Store"',
        },
      ];
  }
  if (fact === "batch-onrun-included-duplicates" && cus.length === 3) {
    // The OnRun writer's row reaches the later codeunits, which stream a second row (a carry).
    tests.push(capRow(50752, "ReaderSeesNoRow", "fail", "reader: carried row 7"));
    tests.push(capRow(50753, "OtherInsertsAndSeesOne", "fail", "other: count 2"));
  }
  if (fact === "batch-sequential-carry") {
    // PR-340: with AL_STRICT_SEQUENTIAL=1 and strictOrder the writer runs first and the reader sees its store.
    // (The fake cannot see the variable; the test that reads the spawn options checks it.)
    return {
      tests: cus.flatMap(([id, methods]) =>
        methods.map((m) =>
          m === "WantsZero" ? capRow(id, m, "fail", "carried 5") : capRow(id, m),
        ),
      ),
      summary,
    };
  }
  return { tests, summary };
}

/** PR-342: the stop-groups folder's codeunits, `[method, status, notRun, message]` each, as unstopped. */
const STOP_APP: Record<number, readonly (readonly [string, string, boolean, string?])[]> = {
  50781: [
    ["First", "fail", false, "first fails"],
    ["Second", "pass", false],
  ],
  50782: [["Other", "pass", false]],
  50783: [["Passes", "pass", false]],
  50784: [
    ["Spins", "error", true, "Test exceeded 3s timeout."],
    ["After", "pass", false],
  ],
  50785: [
    ["Refuses", "error", true, "NotRun: out-of-scope: FieldRef.Class on a FieldRef never assigned"],
    ["After", "pass", false],
  ],
};

/** PR-342: upstream #8564's skip text (PR-257), naming the group's first failed test. */
const skipText = (test: string, group: string): string =>
  `NotRun: out-of-scope: the test ${test} failed before it, and stopAfterFirstFailure (--stop-after-first-failure) runs no test of its codeunit or of a later entry of its stopGroup \`${group}\` after a failure`;

/**
 * PR-342: what a #8564 build answers a stop-groups request: entries in order, and with the stop, every row after the
 * first PLAIN fail of a group (a timeout or a refusal row is notRun, never a fail) is skipped with `skipText`.
 */
function stopGroupsAnswer(req: Record<string, unknown>): CapAnswer {
  const stop = req.stopAfterFirstFailure === true;
  const failedIn = new Map<string, string>();
  const tests: Record<string, unknown>[] = [];
  for (const e of (req.entries ?? []) as { id: string; test: string; stopGroup?: string }[]) {
    const id = Number(e.test.slice("Codeunit".length, -1));
    for (const [m, status, notRun, message] of STOP_APP[id] ?? []) {
      const name = `Codeunit${id}.${m}`;
      const g = e.stopGroup;
      const by = stop && g !== undefined ? failedIn.get(g) : undefined;
      if (by !== undefined && g !== undefined) {
        tests.push({ name, entry: e.id, status: "error", notRun: true, message: skipText(by, g) });
        continue;
      }
      tests.push({
        name,
        entry: e.id,
        status,
        notRun,
        ...(message !== undefined ? { message } : {}),
      });
      if (stop && g !== undefined && status === "fail" && !notRun && !failedIn.has(g))
        failedIn.set(g, name);
    }
  }
  return { tests, summary: {} };
}

/** A fake `alrunner serve`: answers every runTests with `rows`; records each argv and request. */
function fakeServe(
  rows: Record<string, { status: string; notRun?: boolean; message?: string }> = SERVE_ROWS,
  o: {
    ready?: boolean;
    /** PR-114a: change one capability fact's answer to a request (default: the measured reading). */
    cap?: (fact: string, req: Record<string, unknown>, def: CapAnswer) => CapAnswer;
    /** PR-363: the rows a family app's request (by its dir) gets; default one kept refusal. */
    family?: (
      dir: string,
    ) => { name: string; status: string; notRun?: boolean; message?: string }[];
  } = {},
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
    let late: CapAnswer | undefined;
    return {
      write: (line: string) => {
        const req = JSON.parse(line) as Record<string, unknown>;
        requests.push(req);
        const capFact = Array.isArray(req.sourcePaths)
          ? folderName(String(req.sourcePaths[0] ?? ""))
          : undefined;
        if (
          req.command === "runTests" &&
          (capFact?.startsWith("batch-") === true || capFact === "stop-groups")
        ) {
          // PR-114a: a capability fact's request (its own scratch folder is named for it). PR-342: and stop-groups'.
          const def =
            capFact === "stop-groups" ? stopGroupsAnswer(req) : capabilityAnswer(capFact, req);
          const ans = o.cap?.(capFact, req, def) ?? def;
          const send = (a: CapAnswer): void => {
            if ("hang" in a) late = a.hang;
            else if ("error" in a) emit(JSON.stringify({ error: a.error }));
            else {
              for (const t of a.tests) emit(JSON.stringify({ type: "test", ...t }));
              emit(JSON.stringify({ type: "summary", exitCode: 1, ...a.summary }));
            }
          };
          // a hung request's answer reaches the pipe only when the next request is written
          const pending = late;
          late = undefined;
          if (pending !== undefined) send(pending);
          send(ans);
        } else if (
          req.command === "runTests" &&
          Array.isArray(req.sourcePaths) &&
          String(req.sourcePaths[0]).startsWith(`${FAKE_KEEP_DIR}/`)
        ) {
          // PR-363: a family app's request (its own fresh daemon); answered by dir, default one kept refusal
          const dir = String(req.sourcePaths[0]);
          const ans = o.family?.(dir) ?? keptRows(dir);
          for (const t of ans) emit(JSON.stringify({ type: "test", ...t }));
          emit(JSON.stringify({ type: "summary", exitCode: 1 }));
        } else if (req.command === "runTests") {
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

describe("R645: the probe's v3 processes run in its scratch dir, not the caller's", () => {
  test("every test call and the serve daemon get a cwd that is not process.cwd(); --version may stay", async () => {
    const inner = fakeV3();
    const seen: { argv: readonly string[]; cwd: string | undefined }[] = [];
    const serveInner = fakeServe();
    const serveCwds: (string | undefined)[] = [];
    await runV3ContractProbe({
      alRunnerPath: "/fake/alrunner",
      expectedVersion: VERSION,
      packagesDir: "/fake/deps",
      bcVersion: BC,
      alcPath: "/fake/alc",
      alcIo: fakeAlcIo,
      tasksetPath: "/usr/bin/taskset",
      startBurner: () => ({ kill: () => {} }),
      spawn: (argv, opts) => {
        seen.push({ argv, cwd: opts?.cwd });
        return inner(argv, opts);
      },
      serveSpawn: (argv, opts) => {
        serveCwds.push(opts?.cwd);
        return serveInner.spawn(argv, opts);
      },
      libraryAssertApp: LIBRARY_ASSERT,
    });
    const calls = seen.filter((s) => s.argv[1] === "test");
    expect(calls.length).toBeGreaterThan(5);
    for (const c of calls) {
      expect(c.cwd).toBeDefined();
      expect(c.cwd).not.toBe(process.cwd());
    }
    // PR-114a: serve-keep-reasons' daemon and the capability facts' daemon; PR-340: and the carry fact's own; PR-342: and stop-groups'.
    // PR-363: and one fresh daemon per family app, after serve-keep-reasons' own (now 4 + V3_KEEP_APP_FAMILIES)
    expect(serveCwds).toHaveLength(4 + V3_KEEP_APP_FAMILIES);
    for (const c of serveCwds) {
      expect(c).toBeDefined();
      expect(c).not.toBe(process.cwd());
    }
  });
});

describe("R938: the probe runs under the session's environment", () => {
  const run = async (environment?: "saas" | "onprem") => {
    const inner = fakeV3();
    const argvs: (readonly string[])[] = [];
    const serve = fakeServe();
    await runV3ContractProbe({
      alRunnerPath: "/fake/alrunner",
      expectedVersion: VERSION,
      packagesDir: "/fake/deps",
      bcVersion: BC,
      ...(environment !== undefined ? { environment } : {}),
      alcPath: "/fake/alc",
      alcIo: fakeAlcIo,
      tasksetPath: "/usr/bin/taskset",
      startBurner: () => ({ kill: () => {} }),
      spawn: (argv, opts) => {
        argvs.push(argv);
        return inner(argv, opts);
      },
      serveSpawn: serve.spawn,
    });
    return { argvs, serve };
  };
  test("every test leg and the serve daemon carry --environment <value>; the flag-rejection call and the mask probe do not", async () => {
    const { argvs, serve } = await run("onprem");
    const tests = argvs.filter(
      (a) => a.includes("test") && !a.includes("--lethal-wire-contract-probe"),
    );
    const real = tests.filter((a) => a.includes("--bc-version") && a.includes("--output-json"));
    const stated = real.filter((a) => a.includes("--environment"));
    expect(stated.length).toBeGreaterThan(5);
    for (const a of stated) expect(a[a.indexOf("--environment") + 1]).toBe("onprem");
    // The one call without it is the mask probe (`probeV3PredefinedSymbols`), on the default.
    expect(real.length - stated.length).toBe(1);
    expect(serve.argvs[0]).toContain("onprem");
  });
  test("with none given, no leg passes --environment", async () => {
    const { argvs, serve } = await run();
    expect(argvs.some((a) => a.includes("--environment"))).toBe(false);
    expect(serve.argvs[0]).not.toContain("--environment");
  });
});

const probe = (
  over: Over = {},
  serveSpawn = fakeServe().spawn,
  serveKeepMoved = false,
  serveDeadlineMs?: number,
): Promise<V3ContractResult> =>
  runV3ContractProbe({
    ...(serveKeepMoved ? { serveKeepMoved: true } : {}),
    ...(serveDeadlineMs !== undefined ? { serveDeadlineMs } : {}),
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
    // PR-363: SERVE_CASES' rows plus the V3_KEEP_CASES family cases
    expect(f?.measured).toContain(
      `the keep rule accepts every row of all ${SERVE_CASES.length + V3_KEEP_CASES} entries`,
    );
    // R998, R1019, R1043, R1009, PR-47, PR-53, PR-54: each new family judged a refusal by its own entry
    for (const e of [
      "download-from-stream-needs-client",
      "setfilter-boolean-language-words",
      "gotokey-desc-last-row-above-window",
      "stale-buffer-after-lock",
      "recordref-not-open",
      "fieldref-never-assigned",
      "gettable-unassigned-variant",
      "cascade-manual-binding",
      "format-region-std4",
      "caption-no-source-table",
    ])
      expect(f?.measured).toContain(`${e}: refusal`);
    expect(f?.measured).toContain("http: refusal");
    expect(f?.measured).toContain("cascade: refusal");
    expect(f?.measured).toContain("cascade-existing-state: refusal");
    // PR-114a: a second daemon, with the same argv, measures the capability facts; PR-340: a third, the carry fact's own; PR-342: a fourth, stop-groups'.
    const serveArgv = [resolve("/fake/alrunner"), "serve", "--test-timeout", "3"];
    // PR-363: and one more per family app (V3_KEEP_APP_FAMILIES), right after the first
    expect(s.argvs).toEqual(Array.from({ length: 4 + V3_KEEP_APP_FAMILIES }, () => serveArgv));
    const run = s.requests.filter(
      (q) =>
        q.command === "runTests" &&
        !isCapabilityRequest(q) &&
        !isStopGroupsRequest(q) &&
        !String((q.sourcePaths as string[])[0]).startsWith(`${FAKE_KEEP_DIR}/`),
    );
    expect(run.length).toBe(1);
    expect(run[0]?.testIsolation).toBe("test");
    expect(classifyLegC(r.facts, V3_DEFECT_FACTS, V3_LEG_C_FACTS)).toEqual({
      outcome: "pass",
      lines: [],
    });
  });

  // R1000 (coord R-989): a reworded REFUSAL is unkept (no entry accepts it, so a serve warm-up falls back
  // to one-shot): it never refuses a session, and it FAILS leg C. Every entry, the new families included.
  for (const [entry, name] of [
    ["http", "Codeunit50670.HttpGet"],
    ["commit", "Codeunit50671.CommitCall"],
    ["cascade", "Codeunit50672.LaterFails"],
    ["onrun-failed", "Codeunit50673.Never"],
    ["http", "Codeunit50674.HttpGetPublic"],
    ["cascade-existing-state", "Codeunit50675.C_UsesSeq"],
    ["cascade-existing-state", "Codeunit50676.C_UsesKey"],
    ["cascade-manual-binding", "Codeunit50685.B_BindAgain"],
    ["format-region-std4", "Codeunit50687.Refuses"],
    ["caption-no-source-table", "Codeunit50689.Refuses"],
  ] as const) {
    test(`R1000: a reworded ${entry} refusal (${name}) is unkept, names it, never refuses a session, and FAILS leg C`, async () => {
      const rows = {
        ...SERVE_ROWS,
        [name]: { ...SERVE_ROWS[name], message: "NotRun: out-of-scope: reworded" },
      };
      const r = await probe({}, fakeServe(rows as typeof SERVE_ROWS).spawn);
      const f = r.facts.find((x) => x.fact === "serve-keep-reasons");
      expect(f?.verdict).toBe("unkept");
      expect(f?.measured).toContain(`${entry}: UNKEPT ${name}`);
      expect(f?.measured).toContain("reworded");
      expect(v3ContractRefusals(r)).toEqual([]);
      const c = classifyLegC(r.facts, V3_DEFECT_FACTS, V3_LEG_C_FACTS);
      expect(c.outcome).toBe("gate-fail");
      expect(c.lines.join("\n")).toMatch(/gate-fail: serve-keep-reasons: unkept .*R1000/);
    });
  }

  // R612 kept: a row that moved WITHOUT a refusal the keep-list rejects (a plain fail where a refusal
  // was expected, or no row) still only warns.
  for (const [entry, name, moved] of [
    ["commit", "Codeunit50671.CommitCall", { status: "fail", notRun: false, message: "x" }],
    [
      "cascade-existing-state",
      "Codeunit50676.C_UsesKey",
      { status: "fail", notRun: false, message: "x" },
    ],
  ] as const) {
    test(`a ${entry} row that moved to a plain fail is diverged, and leg C still passes with the warning`, async () => {
      const rows = { ...SERVE_ROWS, [name]: moved };
      const r = await probe({}, fakeServe(rows as typeof SERVE_ROWS).spawn);
      const f = r.facts.find((x) => x.fact === "serve-keep-reasons");
      expect(f?.verdict).toBe("diverged");
      expect(f?.measured).toContain(`${entry}: MOVED`);
      const c = classifyLegC(r.facts, V3_DEFECT_FACTS, V3_LEG_C_FACTS);
      expect(c.outcome).toBe("pass");
      expect(c.lines.join("\n")).toMatch(
        new RegExp(
          `al-runner-v3-serve-keep-reason-moved: serve-keep-reasons: diverged.*${entry}: MOVED`,
        ),
      );
    });
  }

  test("R1000: edge-847b1fa5a's per-kind cascade texts are kept, and a build that runs those tests (plain pass) matches too", async () => {
    const today = await probe({}, fakeServe(TODAY_ROWS).spawn, true);
    const f = today.facts.find((x) => x.fact === "serve-keep-reasons");
    expect(f?.verdict).toBe("matches");
    expect((f?.measured.match(/cascade-existing-state: refusal/g) ?? []).length).toBe(2);
    expect(classifyLegC(today.facts, V3_DEFECT_FACTS, V3_LEG_C_FACTS).outcome).toBe("pass");
    const passing = {
      ...TODAY_ROWS,
      "Codeunit50675.C_UsesSeq": { status: "pass", notRun: false },
      "Codeunit50676.C_UsesKey": { status: "pass", notRun: false },
    };
    const p = (await probe({}, fakeServe(passing).spawn, true)).facts.find(
      (x) => x.fact === "serve-keep-reasons",
    );
    expect(p?.verdict).toBe("matches");
    expect((p?.measured.match(/: plain pass/g) ?? []).length).toBe(3); // commit (pinned) + the two
  });

  // R1000 review: the daemon rule's own condition, on every row of the request.
  test("R1000: a refused UNJUDGED row (an earlier test of a case codeunit) no entry accepts is unkept too", async () => {
    const rows = {
      ...SERVE_ROWS,
      "Codeunit50675.B_ChangesSeq": {
        status: "error",
        notRun: true,
        message: "NotRun: out-of-scope: NumberSequence.Next reworded",
      },
    };
    const r = await probe({}, fakeServe(rows).spawn);
    const f = r.facts.find((x) => x.fact === "serve-keep-reasons");
    expect(f?.verdict).toBe("unkept");
    expect(f?.measured).toContain("(unjudged): UNKEPT Codeunit50675.B_ChangesSeq");
    expect(classifyLegC(r.facts, V3_DEFECT_FACTS, V3_LEG_C_FACTS).outcome).toBe("gate-fail");
  });

  test("R1000: a refused row with NO message is unkept (the daemon rule closes on it)", async () => {
    const rows = {
      ...SERVE_ROWS,
      "Codeunit50676.C_UsesKey": { status: "error", notRun: true },
    };
    const f = (await probe({}, fakeServe(rows).spawn)).facts.find(
      (x) => x.fact === "serve-keep-reasons",
    );
    expect(f?.verdict).toBe("unkept");
    expect(f?.measured).toContain("UNKEPT Codeunit50676.C_UsesKey: (no message)");
  });

  test("R1000 review (R705): a request that returns no row at all is unmeasurable (infra-fail), never a warning", async () => {
    const r = await probe({}, fakeServe({}).spawn);
    const f = r.facts.find((x) => x.fact === "serve-keep-reasons");
    expect(f?.verdict).toBe("unmeasurable");
    expect(f?.measured).toContain("no test row at all");
    expect(classifyLegC(r.facts, V3_DEFECT_FACTS, V3_LEG_C_FACTS).outcome).toBe("infra-fail");
  });

  const serveFact = async (rows: Record<string, ServeRow>) =>
    (await probe({}, fakeServe(rows).spawn)).facts.find((x) => x.fact === "serve-keep-reasons");

  // R1026: edge-5a58a0f16 runs R998's RecordRef and GetTable cases and fails them with BC's error
  // (PR-14's gate, `/coord/handoff/PR-14/v3gate.txt`), so the fact read `diverged` on every candidate.
  test("R1026: R998's RecordRef and GetTable cases accept a plain fail with BC's error; another text, or FieldRef.Class, moves", async () => {
    const notOpen = { status: "fail", notRun: false, message: "The record is not open." };
    const fixed: Record<string, ServeRow> = {
      ...SERVE_ROWS,
      "Codeunit50677.Refuses": notOpen,
      "Codeunit50678.Refuses": notOpen,
      "Codeunit50679.Refuses": notOpen,
      "Codeunit50680.Refuses": notOpen,
      "Codeunit50682.Refuses": {
        status: "fail",
        notRun: false,
        message: "Microsoft.Dynamics.Nav.Runtime.NavVariant variable not initialized.",
      },
    };
    const f = await serveFact(fixed);
    expect(f?.verdict).toBe("matches"); // red before R1026: diverged, MOVED x5
    expect(f?.measured).toContain("recordref-not-open: plain fail");
    expect(f?.measured).toContain("gettable-unassigned-variant: plain fail");
    // another plain-fail text is a move
    const other = await serveFact({
      ...fixed,
      "Codeunit50678.Refuses": { status: "fail", notRun: false, message: "something else" },
    });
    expect(other?.verdict).toBe("diverged");
    expect(other?.measured).toContain("recordref-not-open: MOVED fail notRun=false something else");
    // FieldRef.Class accepts no plain fail
    const field = await serveFact({
      ...fixed,
      "Codeunit50681.Refuses": { status: "fail", notRun: false, message: "anything" },
    });
    expect(field?.verdict).toBe("diverged");
    expect(field?.measured).toContain("fieldref-never-assigned: MOVED");
  });

  test("R705 fixed build: the four compilable cases come back as rows, not no row", async () => {
    const r = await probe({}, fakeServe(FIXED_ROWS).spawn);
    const f = r.facts.find((x) => x.fact === "serve-keep-reasons");
    expect(f?.verdict).toBe("matches");
    expect(f?.measured).toContain("http: plain fail");
    expect(f?.measured).toContain("cascade: plain fail");
    expect(f?.measured).toContain("commit: refusal");
    expect(classifyLegC(r.facts, V3_DEFECT_FACTS, V3_LEG_C_FACTS).outcome).toBe("pass");
  });

  test("R705 guard: the probe's tests app has no uncompilable test", () => {
    expect(SERVE_TESTS_AL).not.toContain("NoSuchProcedure");
    // R1019: 50683 (publisher) and 50684 (manual subscriber) are support codeunits of 50685's cascade;
    // PR-29: 50691 is the delete subscriber of 50690's table (the measured shape has one).
    // PR-47: 50694 is the GoToKey case's test codeunit.
    // PR-53: 50696 is the SetFilter-Boolean case's test codeunit.
    // PR-54: 50697 is the File.DownloadFromStream case's test codeunit. The zip family needs the .NET
    // helper, which the update gate does not have (R1017): no dotnet declaration here.
    expect(SERVE_TESTS_AL.match(/^codeunit 506[789]\d /gm)).toHaveLength(23);
    expect(SERVE_TESTS_AL).not.toMatch(/^dotnet\b|DotNet /m);
    // R1043: the caption case's page; PR-47: the GoToKey case's list page.
    expect(SERVE_TESTS_AL.match(/^page 506[789]\d /gm)).toHaveLength(2);
    // PR-18: the FormatRegion case's report.
    expect(SERVE_TESTS_AL.match(/^report 506[789]\d /gm)).toHaveLength(1);
    // PR-29: the stale-buffer case's table; PR-47: the GoToKey case's table.
    // PR-53: the SetFilter-Boolean case's table.
    // PR-54: 50698 holds the Blob the download and zip cases read.
    expect(SERVE_TESTS_AL.match(/^table 506[789]\d /gm)).toHaveLength(4);
    // R1000 (R-989, measured on the gate): the serve daemon has no package cache, so no System record.
    expect(SERVE_TESTS_AL).not.toMatch(/Record Company\b/);
  });

  // R808 (d): pinned (the build's pin has serveKeepMoved), the fact expects commit a plain pass and
  // no row for Never; every other reading of those two is diverged.
  const pinnedFact = async (rows: Record<string, ServeRow>) =>
    (await probe({}, fakeServe(rows).spawn, true)).facts.find(
      (x) => x.fact === "serve-keep-reasons",
    );

  test("R808 pinned: today's rows read matches", async () => {
    const f = await pinnedFact(TODAY_ROWS);
    expect(f?.verdict).toBe("matches");
    expect(f?.measured).toContain("commit: plain pass (pinned)");
    expect(f?.measured).toContain("onrun-failed: no row (pinned)");
    expect(f?.measured).toContain("http: plain fail");
    expect(f?.measured).toContain("http: refusal");
    expect(f?.expected).toContain("this build's pin (R808)");
  });

  test("R808 pinned: a commit refusal reads diverged", async () => {
    const f = await pinnedFact({
      ...TODAY_ROWS,
      "Codeunit50671.CommitCall": SERVE_ROWS["Codeunit50671.CommitCall"] as ServeRow,
    });
    expect(f?.verdict).toBe("diverged");
    expect(f?.measured).toContain("commit: MOVED");
  });

  test("R808 pinned: a pass row flagged notRun, or a plain fail, for commit reads diverged", async () => {
    for (const row of [
      { status: "pass", notRun: true },
      { status: "fail", notRun: false, message: "x" },
    ])
      expect((await pinnedFact({ ...TODAY_ROWS, "Codeunit50671.CommitCall": row }))?.verdict).toBe(
        "diverged",
      );
  });

  test("R808 pinned: a row for Never (a refusal or a plain fail) reads diverged", async () => {
    for (const row of [
      SERVE_ROWS["Codeunit50673.Never"] as ServeRow,
      { status: "fail", notRun: false, message: "Codeunit50673.OnRun failed" },
    ]) {
      const f = await pinnedFact({ ...TODAY_ROWS, "Codeunit50673.Never": row });
      expect(f?.verdict).toBe("diverged");
      expect(f?.measured).toContain("onrun-failed: MOVED");
    }
  });

  test("R808: the public-host row as a plain fail reads diverged, pinned or not", async () => {
    const row = { status: "fail", notRun: false, message: "boom" };
    expect((await pinnedFact({ ...TODAY_ROWS, "Codeunit50674.HttpGetPublic": row }))?.verdict).toBe(
      "diverged",
    );
    expect((await serveFact({ ...FIXED_ROWS, "Codeunit50674.HttpGetPublic": row }))?.verdict).toBe(
      "diverged",
    );
  });

  test("R808 (e): unpinned, today's rows still read diverged for commit and onrun-failed", async () => {
    const f = await serveFact(TODAY_ROWS);
    expect(f?.verdict).toBe("diverged");
    expect(f?.measured).toContain("commit: MOVED pass");
    expect(f?.measured).toContain("onrun-failed: MOVED no row");
    expect(f?.measured).not.toContain("http: MOVED");
  });

  test("R705: the tolerance is narrow", async () => {
    const http = "Codeunit50670.HttpGet";
    // commit as a plain fail: only http and cascade tolerate one.
    expect(
      (
        await serveFact({
          ...FIXED_ROWS,
          "Codeunit50671.CommitCall": { status: "fail", notRun: false, message: "x" },
        })
      )?.verdict,
    ).toBe("diverged");
    // http as a pass row.
    expect((await serveFact({ ...FIXED_ROWS, [http]: { status: "pass" } }))?.verdict).toBe(
      "diverged",
    );
    // http as a fail that did not run.
    expect(
      (
        await serveFact({
          ...FIXED_ROWS,
          [http]: { status: "fail", notRun: true, message: "later" },
        })
      )?.verdict,
    ).toBe("diverged");
    // http as a plain fail that holds v3's refusal marker.
    expect(
      (
        await serveFact({
          ...FIXED_ROWS,
          [http]: { status: "fail", notRun: false, message: "NotRun: out-of-scope: x" },
        })
      )?.verdict,
    ).toBe("diverged");
    // http as a plain fail with NO message.
    expect(
      (
        await serveFact({
          ...FIXED_ROWS,
          [http]: { status: "fail", notRun: false },
        })
      )?.verdict,
    ).toBe("diverged");
    // cascade as a plain fail with another message.
    expect(
      (
        await serveFact({
          ...FIXED_ROWS,
          "Codeunit50672.LaterFails": { status: "fail", notRun: false, message: "other" },
        })
      )?.verdict,
    ).toBe("diverged");
  });

  test("R705: no row is never OK for the tolerated cases", async () => {
    // R1000 review: no row at ALL is unmeasurable (the whole request ran nothing); one case's row
    // missing is that case MOVED.
    const none = await serveFact({});
    expect(none?.verdict).toBe("unmeasurable");
    const { "Codeunit50670.HttpGet": _gone, ...noHttp } = FIXED_ROWS;
    const f = await serveFact(noHttp);
    expect(f?.verdict).toBe("diverged");
    expect(f?.measured).toContain("http: MOVED no row");
  });

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

  test("serve does not start: unmeasurable; never refuses a session, and since R1000 leg C is infra-fail (an unmeasured fact could hide an unkept refusal)", async () => {
    const r = await probe({}, fakeServe(SERVE_ROWS, { ready: false }).spawn);
    expect(r.facts.find((x) => x.fact === "serve-keep-reasons")?.verdict).toBe("unmeasurable");
    expect(v3ContractRefusals(r)).toEqual([]);
    const c = classifyLegC(r.facts, V3_DEFECT_FACTS, V3_LEG_C_FACTS);
    expect(c.outcome).toBe("infra-fail");
    expect(c.lines.join("\n")).toMatch(/infra-fail: serve-keep-reasons: unmeasurable/);
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
      // PR-114a: a session does start serve, for the capability facts alone (PR-340: and the carry fact's own daemon).
      expect(s.argvs.length).toBe(2);
      expect(
        s.requests.filter((q) => q.command === "runTests").every((q) => isCapabilityRequest(q)),
      ).toBe(true);
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
    expect(
      s.requests.filter((q) => q.command === "runTests").every((q) => isCapabilityRequest(q)),
    ).toBe(true);
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
        "batch-sequential-carry",
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
        // PR-114a: the capability facts
        "batch-no-cross-singleinstance",
        "batch-no-cross-library-global",
        "batch-no-cross-row",
        "batch-no-cross-subscriber",
        "batch-onrun-excluded-no-carry",
        "batch-onrun-included-duplicates",
        "batch-lane-hint-only",
        "batch-lane-strict-reruns",
        // PR-342
        "stop-groups",
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
});

describe("PR-114a: the eight capability facts", () => {
  type Body = Record<string, unknown>;
  const readOf = async (cap?: (fact: string, req: Body, def: CapAnswer) => CapAnswer) => {
    const serve = fakeServe(SERVE_ROWS, cap !== undefined ? { cap } : {});
    const r = await probe({}, serve.spawn);
    const f = (name: string) => r.facts.find((x) => x.fact === name);
    return { r, f, serve };
  };
  test("as edge-4ebfe7913 measured: all eight read matches, kind capability, none refuses a session", async () => {
    const { r, f } = await readOf();
    for (const n of V3_CAPABILITY_FACTS)
      expect(f(n), n).toMatchObject({ kind: "capability", verdict: "matches" });
    // PR-340: the carry fact is read beside the eight, but is NOT one of them.
    expect(f(V3_CARRY_FACT)).toMatchObject({ kind: "capability", verdict: "matches" });
    expect((V3_CAPABILITY_FACTS as readonly string[]).includes(V3_CARRY_FACT)).toBe(false);
    expect(r.facts.filter((x) => x.kind === "capability").map((x) => x.fact)).toEqual([
      ...V3_CAPABILITY_FACTS,
      V3_CARRY_FACT,
      STOP_GROUPS_FACT,
    ]);
    expect(v3ContractRefusals(r)).toEqual([]);
    expect(classifyLegC(r.facts, V3_DEFECT_FACTS, V3_LEG_C_FACTS).outcome).toBe("pass");
  });

  // Each no-cross fact: a build whose batch lets the writer's state reach the reader reads diverged.
  const NO_CROSS: [string, number, string, string][] = [
    ["batch-no-cross-singleinstance", 50703, "SeesNoCounter", "counter 1"],
    ["batch-no-cross-library-global", 50713, "SeesFreshLibrary", "library global carried"],
    ["batch-no-cross-row", 50723, "SeesNoRealRow", "real rows 1"],
    ["batch-no-cross-subscriber", 50734, "SeesNoBoundSubscriber", "subscriber still bound"],
  ];
  for (const [fact, reader, method, msg] of NO_CROSS) {
    test(`${fact}: matches when the batch's reader rows equal the reader alone; diverged when state crossed`, async () => {
      const crossed = await readOf((name, q, def) =>
        name === fact && q.test === undefined && "tests" in def
          ? {
              ...def,
              tests: def.tests.map((t) =>
                t.name === `Codeunit${reader}.${method}`
                  ? { ...t, status: "fail", message: msg }
                  : t,
              ),
            }
          : def,
      );
      expect(crossed.f(fact)).toMatchObject({ verdict: "diverged" });
      expect(crossed.f(fact)?.measured).toContain(msg);
      // the other seven are not touched by this fact's divergence
      for (const n of V3_CAPABILITY_FACTS.filter((x) => x !== fact))
        expect(crossed.f(n)?.verdict, n).toBe("matches");
      // a session still accepts it; the gate does not
      expect(v3ContractRefusals(crossed.r)).toEqual([]);
      expect(classifyLegC(crossed.r.facts, V3_DEFECT_FACTS, V3_LEG_C_FACTS).outcome).toBe(
        "gate-fail",
      );
    });

    test(`${fact}: empty answers do not match (empty equals empty is not a pass); a request error is unmeasurable`, async () => {
      const empty = await readOf((name, _q, def) =>
        name === fact && "tests" in def ? { ...def, tests: [] } : def,
      );
      expect(empty.f(fact)?.verdict).toBe("diverged");
      // the reader gives no row ANYWHERE (alone and in the batch): empty equals empty, which must not pass
      const noReader = await readOf((name, _q, def) =>
        name === fact && "tests" in def
          ? {
              ...def,
              tests: def.tests.filter((t) => !String(t.name).startsWith(`Codeunit${reader}.`)),
            }
          : def,
      );
      expect(noReader.f(fact)?.verdict).toBe("diverged");
      const err = await readOf((name, _q, def) => (name === fact ? { error: "boom" } : def));
      expect(err.f(fact)?.verdict).toBe("unmeasurable");
      expect(err.f(fact)?.measured).toContain("boom");
      // a request error closes this daemon's request only; the other facts still read
      expect(err.f("batch-lane-hint-only")?.verdict).toBe("matches");
    });
  }

  // PR-117 (M-2): the alone reference is reported apart from the batch half.
  const REF: [string, number][] = [
    ["batch-no-cross-singleinstance", 50703],
    ["batch-no-cross-library-global", 50713],
    ["batch-no-cross-row", 50723],
    ["batch-no-cross-subscriber", 50734],
    ["batch-onrun-excluded-no-carry", 50742],
  ];
  for (const [fact, reader] of REF) {
    const failRows = (def: CapAnswer): CapAnswer =>
      "tests" in def
        ? {
            ...def,
            tests: def.tests.map((t) =>
              String(t.name).startsWith(`Codeunit${reader}.`)
                ? { ...t, status: "fail", message: "boom" }
                : t,
            ),
          }
        : def;
    test(`PR-117 ${fact}: reference is pass when the single request is right and only the batch diverged; fail when the single request fails; none when it ran nothing`, async () => {
      const all = await readOf();
      expect(all.f(fact)?.reference, "matches").toBe("pass");
      const batchOnly = await readOf((n, q, def) =>
        n === fact && q.test === undefined ? failRows(def) : def,
      );
      expect(batchOnly.f(fact)).toMatchObject({ verdict: "diverged", reference: "pass" });
      const aloneBad = await readOf((n, q, def) =>
        n === fact && q.test !== undefined ? failRows(def) : def,
      );
      expect(aloneBad.f(fact)?.reference).toBe("fail");
      const aloneEmpty = await readOf((n, q, def) =>
        n === fact && q.test !== undefined && "tests" in def ? { ...def, tests: [] } : def,
      );
      expect(aloneEmpty.f(fact)?.reference).toBe("none");
    });
  }

  // PR-117 (M2): a writer that fails in the batch is not "only the batch half differs": no reference at all.
  const WRITERS: [string, number][] = [
    ["batch-no-cross-singleinstance", 50702],
    ["batch-no-cross-library-global", 50712],
    ["batch-no-cross-row", 50722],
    ["batch-no-cross-subscriber", 50733],
  ];
  for (const [fact, writer] of WRITERS) {
    test(`PR-117 ${fact}: the writer failing in the batch while the reader passes alone leaves no reference, so diverged gate-fails`, async () => {
      const r = await readOf((n, q, def) =>
        n === fact && q.test === undefined && "tests" in def
          ? {
              ...def,
              tests: def.tests.map((t) =>
                String(t.name).startsWith(`Codeunit${writer}.`)
                  ? { ...t, status: "fail", message: "writer broke" }
                  : t,
              ),
            }
          : def,
      );
      const f = r.f(fact);
      expect(f?.verdict).toBe("diverged");
      expect(f !== undefined && "reference" in f).toBe(false);
      expect(
        classifyLegC(r.r.facts, V3_DEFECT_FACTS, V3_LEG_C_FACTS, undefined, undefined, [
          ...V3_CAPABILITY_FACTS,
        ]).outcome,
      ).toBe("gate-fail");
    });
  }

  // PR-117 (M3): a fact with no alone reference by design carries no `reference` field.
  test("PR-117: the three judges with no alone reference emit no reference, whatever they read", async () => {
    const NONE = [
      "batch-onrun-included-duplicates",
      "batch-lane-hint-only",
      "batch-lane-strict-reruns",
    ];
    const ok = await readOf();
    const bad = await readOf((n, _q, def) =>
      NONE.includes(n) && "tests" in def ? { ...def, tests: [], summary: {} } : def,
    );
    for (const n of NONE) {
      expect(ok.f(n)?.verdict, n).toBe("matches");
      expect(bad.f(n)?.verdict, n).toBe("diverged");
      for (const x of [ok.f(n), bad.f(n)])
        expect(x !== undefined && "reference" in x, n).toBe(false);
    }
  });

  test("Windows-style paths: the scratch folders arrive with backslashes and every fact still reads matches", async () => {
    const serve = fakeServe();
    const win: ServerSpawnFn = (argv, opts) => {
      const h = serve.spawn(argv, opts);
      return { ...h, write: (l: string) => h.write(l.replaceAll("/", "\\\\")) };
    };
    const r = await probe({}, win);
    for (const n of [...V3_CAPABILITY_FACTS, V3_CARRY_FACT, STOP_GROUPS_FACT])
      expect(r.facts.find((x) => x.fact === n)?.verdict, n).toBe("matches");
    expect(r.facts.length).toBe(38);
    expect(classifyLegC(r.facts, V3_DEFECT_FACTS, V3_LEG_C_FACTS).outcome).toBe("pass");
  });

  test("M1: a request that never answers in time reads unmeasurable, and its LATE rows never reach the next fact", async () => {
    const serve = fakeServe(SERVE_ROWS, {
      cap: (name, q, def) =>
        name === "batch-no-cross-singleinstance" && q.test !== undefined ? { hang: def } : def,
    });
    const r = await probe({}, serve.spawn, false, 50);
    const f = (n: string) => r.facts.find((x) => x.fact === n);
    expect(f("batch-no-cross-singleinstance")?.verdict).toBe("unmeasurable");
    expect(f("batch-no-cross-singleinstance")?.measured).toMatch(/no summary line within 50 ms/);
    // the next fact, and every other, reads as if nothing had happened: a fresh daemon after the timeout
    for (const n of V3_CAPABILITY_FACTS.filter((x) => x !== "batch-no-cross-singleinstance"))
      expect(f(n)?.verdict, n).toBe("matches");
    expect(serve.argvs.length).toBe(5 + V3_KEEP_APP_FAMILIES); // serve-keep-reasons, then PR-363's family daemons, the capability daemon, its replacement, the carry fact's daemon, stop-groups'
  });

  test("batch-onrun-excluded-no-carry: diverged when the excluded OnRun writer's row reaches the batch", async () => {
    const { f } = await readOf((name, q, def) =>
      name === "batch-onrun-excluded-no-carry" && q.test === undefined && "tests" in def
        ? {
            ...def,
            tests: def.tests.map((t) =>
              t.name === "Codeunit50742.ReaderSeesNoRow"
                ? { ...t, status: "fail", message: "reader: carried row 7" }
                : t,
            ),
          }
        : def,
    );
    expect(f("batch-onrun-excluded-no-carry")).toMatchObject({ verdict: "diverged" });
  });

  test("batch-onrun-included-duplicates: matches on the carry's signature (a second row); diverged when none appears", async () => {
    const { f } = await readOf((name, _q, def) =>
      name === "batch-onrun-included-duplicates" && "tests" in def
        ? { ...def, tests: def.tests.slice(0, 3) }
        : def,
    );
    expect(f("batch-onrun-included-duplicates")).toMatchObject({
      verdict: "diverged",
    });
    // exactly the pre-committed shape matches: writer once, reader and other twice
    expect((await readOf()).f("batch-onrun-included-duplicates")?.measured).toContain(
      "Codeunit50752.ReaderSeesNoRow=fail(reader: carried row 7)",
    );
  });

  test("batch-lane-hint-only: matches with the hint and the failing reader; diverged without the hint, with a re-run, or with another message", async () => {
    const F = "batch-lane-hint-only";
    const noHint = await readOf((n, _q, d) =>
      n === F && "tests" in d ? { ...d, summary: {} } : d,
    );
    expect(noHint.f(F)?.verdict).toBe("diverged");
    const wrongGlobal = await readOf((n, _q, d) =>
      n === F && "tests" in d
        ? {
            ...d,
            summary: { orderHints: [{ name: "Codeunit50763.NeedsFive", orderHint: "other" }] },
          }
        : d,
    );
    expect(wrongGlobal.f(F)?.verdict).toBe("diverged");
    const rerun = await readOf((n, _q, d) =>
      n === F && "tests" in d
        ? { ...d, tests: [...d.tests, { name: "Codeunit50763.NeedsFive", status: "pass" }] }
        : d,
    );
    expect(rerun.f(F)?.verdict).toBe("diverged");
    const msg = await readOf((n, _q, d) =>
      n === F && "tests" in d
        ? {
            ...d,
            tests: d.tests.map((t) => (t.status === "fail" ? { ...t, message: "store is 5" } : t)),
          }
        : d,
    );
    expect(msg.f(F)?.verdict).toBe("diverged");
  });

  test("batch-lane-strict-reruns: matches on a failing then passing reader; diverged when the reader is not re-run or fails again", async () => {
    const F = "batch-lane-strict-reruns";
    const noRerun = await readOf((n, _q, d) =>
      n === F && "tests" in d ? { ...d, tests: d.tests.slice(0, 2) } : d,
    );
    expect(noRerun.f(F)?.verdict).toBe("diverged");
    const failsAgain = await readOf((n, _q, d) =>
      n === F && "tests" in d
        ? {
            ...d,
            tests: d.tests.map((t, i) =>
              i === 3 ? { ...t, status: "fail", message: "store is 0" } : t,
            ),
          }
        : d,
    );
    expect(failsAgain.f(F)?.verdict).toBe("diverged");
  });

  // PR-403 (pre-commitment docs/superpowers/specs/2026-11-24-pr403-strict-order-sequential-walk.md): upstream's ADR-070 step 3
  // (6a31851380, f479ec6c13, d328ade49f) replaced the lane re-run with a sequential walk. Edge e5176a9fd reads exactly two rows:
  // the writer, then the reader once, both pass. That shape matches too; the re-run still matches; anything else diverges.
  describe("batch-lane-strict-reruns after ADR-070 step 3 (PR-403)", () => {
    const F = "batch-lane-strict-reruns";
    const W = (s = "pass", msg?: string) => ({ ...capRow(50772, "StoresFive", s, msg) });
    const R = (s = "pass", msg?: string) => ({ ...capRow(50773, "NeedsFive", s, msg) });
    const withRows = (rows: Record<string, unknown>[]) =>
      readOf((n, _q, d) => (n === F && "tests" in d ? { ...d, tests: rows } : d));

    test("the sequential walk (writer pass, then the reader once, pass) reads matches", async () => {
      expect((await withRows([W(), R()])).f(F)?.verdict).toBe("matches");
    });
    test("the old re-run (reader fails 'store is 0', then passes) still reads matches", async () => {
      expect((await readOf()).f(F)?.verdict).toBe("matches");
    });
    test.each([
      ["the reader fails once with no re-run", [W(), R("fail", "store is 0")]],
      ["the reader before the writer", [R(), W()]],
      ["a third row after the walk", [W(), R(), W()]],
      ["the writer fails, the reader passes", [W("fail", "x"), R()]],
      ["the reader alone", [R()]],
      ["the reader twice, both pass (no writer)", [R(), R()]],
    ])("neither shape: %s reads diverged", async (_name, rows) => {
      expect((await withRows(rows as Record<string, unknown>[])).f(F)?.verdict).toBe("diverged");
    });
  });

  test("the requests: LethAL's batch body (isolation test, coverage, per-test coverage); one folder per fact; only the strict fact sends strictOrder", async () => {
    const { serve } = await readOf();
    const cap = serve.requests.filter((q) => q.command === "runTests" && isCapabilityRequest(q));
    // 4 no-cross x2, excluded-no-carry x3, included x1, hint x1, strict x1
    expect(cap).toHaveLength(15);
    for (const q of cap) {
      expect(q.testIsolation).toBe("test");
      expect(q.coverage).toBe(true);
      expect(q.perTestCoverage).toBe(true);
      for (const k of ["runSelectedOnly", "testSuites", "testRunner", "testDriver"])
        expect(Object.hasOwn(q, k), k).toBe(false);
      expect(Array.isArray(q.sourcePaths) && q.sourcePaths.length === 1).toBe(true);
    }
    const dirs = new Set(cap.map((q) => (q.sourcePaths as string[])[0] ?? ""));
    expect([...dirs].map(folderName).sort()).toEqual(
      [...V3_CAPABILITY_FACTS, V3_CARRY_FACT].sort(),
    );
    const strict = cap.filter((q) => Object.hasOwn(q, "strictOrder"));
    expect(strict.map((q) => folderName((q.sourcePaths as string[])[0] ?? ""))).toEqual([
      "batch-lane-strict-reruns",
      V3_CARRY_FACT,
    ]);
    // the batch requests name the complement in excludeTests and carry no `test`
    // (L2) every batch request, of every fact, has a non-empty complement: LethAL's body
    const batches = cap.filter((x) => x.test === undefined);
    expect(batches).toHaveLength(9);
    for (const q of batches)
      expect(
        (q.excludeTests as string[] | undefined)?.length ?? 0,
        String((q.sourcePaths as string[])[0]),
      ).toBeGreaterThan(0);
  });

  test("the invented AL: ids in 50700-50789, ten per fact, none in the main probe's 50600-50699, and no DotNet", async () => {
    const seen = new Map<string, string>();
    let stopAl: string | undefined;
    const { r } = await readOf((name, q, def) => {
      const dir = (q.sourcePaths as string[])[0] ?? "";
      if (name === "stop-groups" && stopAl === undefined)
        stopAl = readFileSync(join(dir, "src", "Stop.Codeunit.al"), "utf8");
      else if (!seen.has(name))
        seen.set(name, readFileSync(join(dir, "src", "Batch.Codeunit.al"), "utf8"));
      return def;
    });
    expect(r.facts.length).toBe(38);
    expect([...seen.keys()].sort()).toEqual([...V3_CAPABILITY_FACTS, V3_CARRY_FACT].sort());
    // PR-342: stop-groups' own AL, ids 50781-50785 (its own scratch folder, so the carry fact's 50780s do not meet it).
    const stopIds = [...(stopAl ?? "").matchAll(/^codeunit (\d+) /gm)].map((m) => Number(m[1]));
    expect(stopIds).toEqual([50781, 50782, 50783, 50784, 50785]);
    expect(stopAl).not.toMatch(/DotNet/);
    for (const [name, al] of seen) {
      const ids = [...al.matchAll(/^(?:table|codeunit) (\d+) /gm)].map((m) => Number(m[1]));
      expect(ids.length, name).toBeGreaterThan(2);
      for (const id of ids) {
        expect(id, name).toBeGreaterThanOrEqual(50700);
        expect(id, name).toBeLessThanOrEqual(50789);
        expect(Math.floor((id - 50700) / 10), name).toBe(
          Math.floor((Math.min(...ids) - 50700) / 10),
        );
      }
      expect(al, name).not.toMatch(/DotNet/);
    }
  });
});

describe("R693 r14b: timeout-is-cpu runs one huge burn alone, then beside busy loops", () => {
  /** "hang-rows": killed by the process timeout, but its stdout already holds a late timeout row. */
  type Ans =
    | { exitCode: number; stdout: string; cpuMs?: number; wallMs?: number }
    | "hang"
    | "hang-rows"
    | undefined;
  /**
   * Runs the probe; `a` and `b` answer the first (alone) and second (shared) call of codeunit 50656.
   * "hang" waits for the call's process timeout and returns as a killed process does.
   */
  const run = async (
    a: Ans | readonly Ans[],
    b: Ans,
    burnerThrowsAt = 0,
    stat?: string[],
    status?: string,
  ) => {
    // R822: an array answers run A's tries in order; the call after them is B.
    const tries: readonly Ans[] = Array.isArray(a) ? a : [a as Ans];
    const answer = (nth: number): Ans => (nth <= tries.length ? tries[nth - 1] : b);
    const events: string[] = [];
    const cores: number[] = [];
    let statReads = 0;
    const argvs: (readonly string[])[] = [];
    const guards: (number | undefined)[] = [];
    let starts = 0;
    let n = 0;
    const base = fakeV3({
      "cu50656-shared-n2": () => {
        const ans = answer(n);
        return ans === "hang" || ans === "hang-rows" ? undefined : ans;
      },
    });
    const probeP = runV3ContractProbe({
      alRunnerPath: "/fake/alrunner",
      expectedVersion: VERSION,
      packagesDir: "/fake/deps",
      bcVersion: BC,
      alcPath: "/fake/alc",
      alcIo: fakeAlcIo,
      tasksetPath: "/usr/bin/taskset",
      ...(stat !== undefined ? { readProcStat: async () => stat[statReads++] } : {}),
      ...(status !== undefined ? { readSelfStatus: async () => status } : {}),
      startBurner: (core) => {
        starts += 1;
        cores.push(core);
        if (starts === burnerThrowsAt) throw new Error("burner failed to start");
        events.push("burner-start");
        return { kill: () => events.push("burner-kill") };
      },
      burnGuardMs: 20,
      spawn: async (argv, o) => {
        const cu = argv.find((_, i) => argv[i - 1] === "--codeunit");
        if (cu === "50656") {
          n += 1;
          argvs.push(argv);
          guards.push(o?.signal !== undefined ? 1 : undefined);
          events.push(`call-${n <= tries.length ? "A" : "B"}`);
          const ans = answer(n);
          if (ans === "hang" || ans === "hang-rows") {
            // A process that never ends: only the call's process timeout (abort signal) stops it.
            await new Promise<void>((resolve) => {
              o?.signal?.addEventListener("abort", () => resolve());
            });
            return {
              exitCode: -1,
              stdout: ans === "hang-rows" ? doc([burnRow(16000)]) : "",
              stderr: "",
              // R822: a share that would read contended, were a killed call ever judged by it.
              ...(ans === "hang-rows" ? { cpuMs: 2000, wallMs: 16000 } : {}),
            };
          }
        }
        return base(argv, o);
      },
      serveSpawn: fakeServe().spawn,
      libraryAssertApp: LIBRARY_ASSERT,
    });
    if (burnerThrowsAt > 0) await probeP.catch(() => undefined);
    const r = burnerThrowsAt > 0 ? undefined : await probeP;
    return {
      r,
      events,
      argvs,
      guards,
      cores,
      f: r?.facts.find((x) => x.fact === "timeout-is-cpu"),
    };
  };

  /** Fake /proc/stat: cpu0 busy (+900 ticks), cpu1 nearly idle (+10), cpu2 busy (+500). */
  const statLine = (n: number, user: number, idle: number) => `cpu${n} ${user} 0 0 ${idle} 0 0 0 0`;
  const snap = (c0: number, c1: number, c2: number, idle = 1000) =>
    [
      "cpu 0 0 0 0 0 0 0 0",
      statLine(0, c0, idle),
      statLine(1, c1, idle),
      statLine(2, c2, idle),
    ].join("\n");
  const BUSY0 = [snap(100, 100, 100), snap(1000, 110, 600)];
  const wallBuild = [snap(100, 100, 100), snap(1000, 110, 600)];

  const ALL_TRIES = Array(BURN_TRIES).fill(0);
  const contendedA = (ms = 16000, cpu = 2000) => ALL_TRIES.map(() => stopped(ms, cpu));

  test("R789 (a): a correct build under contention (A stopped at 16000 ms) is unmeasurable, never diverged; B not run", async () => {
    const { f, events } = await run(
      contendedA(),
      stopped(16100),
      0,
      ALL_TRIES.flatMap(() => BUSY0),
    );
    expect(f?.verdict).toBe("unmeasurable");
    expect(f?.measured).toContain("A late: core 1 contended, cpu 2000 of wall 16000 ms");
    expect(events).toEqual(["call-A", "call-A", "call-A"]);
  });

  test("R822: a contended A retries on a core picked afresh, and a later on-time A reaches B", async () => {
    const quiet = [snap(100, 100, 100), snap(110, 1000, 600)];
    const { f, events, argvs, cores } = await run(
      [stopped(16000, 2000), stopped(2000)],
      stopped(16000),
      0,
      [...BUSY0, ...quiet],
    );
    expect(argvs[2]?.slice(0, 3)).toEqual(["/usr/bin/taskset", "-c", "0"]);
    expect(cores).toEqual(Array(BURN_BUSY_LOOPS).fill(0));
    expect(f?.verdict).toBe("matches");
    expect(events.filter((e) => e === "call-A")).toHaveLength(2);
    expect(events).toContain("call-B");
    expect(argvs[0]?.slice(0, 3)).toEqual(["/usr/bin/taskset", "-c", "1"]);
    expect(argvs[1]?.slice(0, 3)).toEqual(["/usr/bin/taskset", "-c", "0"]);
    expect(f?.measured).toContain("core 0; A");
    expect(f?.measured).toContain(
      "earlier tries of A: core 1 contended, cpu 2000 of wall 16000 ms",
    );
  });

  test("R822: B is judged against the last A, not the contended one", async () => {
    // B is over twice the contended A but not over twice the last one.
    const { f } = await run([stopped(5000, 1000), stopped(10000)], stopped(16000));
    expect(f?.verdict).toBe("diverged");
  });

  test("R822: only a contended A retries: a wall-time build, a killed A and a late A with no CPU reading do not", async () => {
    // Count every call: a retried A past the rig's list takes B's answer and is labelled call-B.
    const wall = await run(stopped(2005), stopped(2010));
    expect(wall.f?.verdict).toBe("diverged");
    expect(wall.argvs).toHaveLength(2);
    const fullShare = await run(stopped(3500, 3450), stopped(3600));
    expect(fullShare.f?.verdict).toBe("diverged");
    expect(fullShare.argvs).toHaveLength(2);
    // On time with a low share of the CPU: a wall-time build on a loaded core.
    const onTimeLoaded = await run(stopped(2005, 500), stopped(2010));
    expect(onTimeLoaded.f?.verdict).toBe("diverged");
    expect(onTimeLoaded.argvs).toHaveLength(2);
    const atTheLine = await run(stopped(3000, 100), stopped(16000));
    expect(atTheLine.argvs).toHaveLength(2);
    const killed = await run("hang", stopped(16000));
    expect(killed.f?.verdict).toBe("diverged");
    expect(killed.events).toEqual(["call-A"]);
    const killedLate = await run("hang-rows", stopped(16000));
    expect(killedLate.f?.verdict).toBe("diverged");
    expect(killedLate.events).toEqual(["call-A"]);
    const notATimeout = await run(
      {
        exitCode: 0,
        stdout: doc([row(50656, "CpuBurnLong", "pass", { durationMs: 16000 })]),
        wallMs: 16000,
        cpuMs: 2000,
      },
      stopped(16000),
    );
    expect(notATimeout.f?.verdict).toBe("diverged");
    expect(notATimeout.events).toEqual(["call-A"]);
    const noCpu = await run(stopped(16000, null), stopped(16000));
    expect(noCpu.f?.verdict).toBe("unmeasurable");
    expect(noCpu.events).toEqual(["call-A"]);
  });

  test("R822: a wall-time build never reads matches, however many tries were contended first", async () => {
    const { f } = await run(
      [stopped(16000, 2000), stopped(16000, 2000), stopped(2005)],
      stopped(2010),
    );
    expect(f?.verdict).toBe("diverged");
  });

  test("addendum 1: a wall-slack build on a free core (A 3500 with cpu 3450, B 3600) reads diverged", async () => {
    const { f, events } = await run(stopped(3500, 3450), stopped(3600));
    expect(f?.verdict).toBe("diverged");
    expect(events).toContain("call-B");
  });

  test("addendum 1: A late with its CPU time unknown is unmeasurable, naming the missing reading; B not run", async () => {
    const { f, events } = await run(stopped(3500, null), stopped(3600));
    expect(f?.verdict).toBe("unmeasurable");
    expect(f?.measured).toContain("CPU time was not read");
    expect(events).toEqual(["call-A"]);
  });

  test("addendum 1: cpu at exactly 0.75 x wall is not contended (B runs); just under is", async () => {
    const edge = await run(stopped(16000, 12000), stopped(40000));
    expect(edge.events).toContain("call-B");
    expect(edge.f?.verdict).toBe("matches");
    const under = await run(contendedA(16000, 11999), stopped(16100));
    expect(under.events).not.toContain("call-B");
    expect(under.f?.verdict).toBe("unmeasurable");
  });

  test("addendum 1: the picker stays inside the allowed list, and the list parses ranges", async () => {
    // cores 0-1 busy, 2-9 idle in /proc/stat; allowed 0-1 -> picks core 1 (less busy), never an idle core 2+.
    const line = (n: number, user: number) => `cpu${n} ${user} 0 0 1000 0 0 0 0`;
    const many = (busy: (n: number) => number) =>
      Array.from({ length: 10 }, (_, n) => line(n, busy(n))).join("\n");
    const before = many(() => 100);
    const after = many((n) => (n === 0 ? 900 : n === 1 ? 300 : 100));
    const status = "Name:\tbun\nCpus_allowed_list:\t0-1\nMems_allowed:\t1\n";
    expect(leastBusyCore(before, after, [0, 1])).toBe(1);
    expect(leastBusyCore(before, after)).toBe(2);
    const { cores, f } = await run(stopped(2010), stopped(16000), 0, [before, after], status);
    expect(cores).toEqual(Array(7).fill(1));
    expect(f?.measured).toContain("core 1;");
    expect(parseAllowedCores("Cpus_allowed_list:\t0-3,8,10-11\n")).toEqual([0, 1, 2, 3, 8, 10, 11]);
    expect(parseAllowedCores("Cpus_allowed_list:\t5\n")).toEqual([5]);
    expect(parseAllowedCores("Cpus_allowed_list:\tx-y\n")).toBeUndefined();
    expect(parseAllowedCores("Name: bun\n")).toBeUndefined();
    expect(parseAllowedCores(undefined)).toBeUndefined();
  });

  test("addendum 1: an unreadable allowed list means core 0", async () => {
    const { cores, argvs } = await run(stopped(2010), stopped(16000), 0, BUSY0, "garbage");
    expect(cores).toEqual(Array(7).fill(0));
    expect(argvs[0]?.slice(0, 3)).toEqual(["/usr/bin/taskset", "-c", "0"]);
  });

  test("R789 (b)+(i): a wall-time build reads diverged, loaded or not (A and B both stop at about 2000 ms)", async () => {
    for (const stat of [undefined, wallBuild]) {
      const { f, events } = await run(stopped(2005), stopped(2010), 0, stat);
      expect(f?.verdict).toBe("diverged");
      expect(events).toContain("call-B");
    }
  });

  test("R789 (c): a correct quiet build (A 2000, B 16000) matches, on the chosen core", async () => {
    const { f } = await run(stopped(2000), stopped(16000), 0, BUSY0);
    expect(f?.verdict).toBe("matches");
    expect(f?.measured).toContain("core 1;");
  });

  test("R789 (ii): the same fake over two probe runs: loaded then quiet reads unmeasurable then matches; a wall-time build diverged both times", async () => {
    const correct = [
      await run(contendedA(), stopped(16000)),
      await run(stopped(2000), stopped(16000)),
    ];
    expect(correct.map((x) => x.f?.verdict)).toEqual(["unmeasurable", "matches"]);
    const wall = [await run(stopped(2000), stopped(2000)), await run(stopped(2000), stopped(2000))];
    expect(wall.map((x) => x.f?.verdict)).toEqual(["diverged", "diverged"]);
  });

  test("R789 (iii): A at exactly 3000 ms is not late (B runs); 3001 is late", async () => {
    const edge = await run(stopped(3000), stopped(16000));
    expect(edge.events).toContain("call-B");
    expect(edge.f?.verdict).toBe("matches");
    const over = await run(contendedA(3001, 100), stopped(16000));
    expect(over.f?.verdict).toBe("unmeasurable");
    expect(over.events).not.toContain("call-B");
  });

  test("R789 (d): the picker takes the least busy core from two snapshots, ties to the lowest, and falls back to 0", () => {
    expect(leastBusyCore(snap(100, 100, 100), snap(1000, 110, 600))).toBe(1);
    expect(leastBusyCore(snap(100, 100, 100), snap(1000, 1000, 110))).toBe(2);
    // iowait and idle do not count as busy: cpu1 only waits, so it is the quietest.
    expect(
      leastBusyCore(
        "cpu0 0 0 0 0 0 0 0 0\ncpu1 0 0 0 0 0 0 0 0",
        "cpu0 50 0 0 0 0 0 0 0\ncpu1 0 0 0 40 60 0 0 0",
      ),
    ).toBe(1);
    expect(leastBusyCore(snap(1, 1, 1), snap(1, 1, 1))).toBe(0);
    expect(leastBusyCore(undefined, snap(1, 1, 1))).toBe(0);
    expect(leastBusyCore("garbage", "")).toBe(0);
  });

  test("R789 (e): both calls and every busy loop use the chosen core; unreadable stat means core 0", async () => {
    const { argvs, cores, f } = await run(stopped(2010), stopped(16000), 0, BUSY0);
    expect(cores).toEqual(Array(7).fill(1));
    for (const argv of argvs) expect(argv.slice(0, 3)).toEqual(["/usr/bin/taskset", "-c", "1"]);
    expect(f?.measured).toContain("core 1;");
    const none = await run(stopped(2010), stopped(16000), 0, []);
    expect(none.cores).toEqual(Array(7).fill(0));
    expect(none.argvs[0]?.slice(0, 3)).toEqual(["/usr/bin/taskset", "-c", "0"]);
    expect(burnerArgv("/usr/bin/taskset", 5).slice(0, 3)).toEqual(["/usr/bin/taskset", "-c", "5"]);
  });

  /** A timeout row of `ms`; the process used `cpu` ms of CPU (default: all of it) over a wall of `ms`. */
  const stopped = (ms: number, cpu: number | null = ms) => ({
    exitCode: 7,
    stdout: doc([burnRow(ms)]),
    wallMs: ms,
    ...(cpu !== null ? { cpuMs: cpu } : {}),
  });
  const passed = {
    exitCode: 0,
    stdout: doc([row(50656, "CpuBurnLong", "pass", { durationMs: 900 })]),
  };
  const noRows = { exitCode: 7, stdout: doc([]) };
  const D = BURN_HUGE;

  test("the burn is one huge constant in the tests app source, and there are 7 busy loops", async () => {
    expect(D).toBe(2_000_000_000);
    expect(BURN_BUSY_LOOPS).toBe(7);
    let src = "";
    const base = fakeV3();
    await runV3ContractProbe({
      alRunnerPath: "/fake/alrunner",
      expectedVersion: VERSION,
      packagesDir: "/fake/deps",
      bcVersion: BC,
      alcPath: "/fake/alc",
      alcIo: fakeAlcIo,
      tasksetPath: "/usr/bin/taskset",
      startBurner: () => ({ kill: () => {} }),
      spawn: async (argv, o) => {
        if (argv.includes("50656"))
          src = await Bun.file(join(argv[argv.length - 1] ?? "", "src", "Burn.Codeunit.al")).text();
        return base(argv, o);
      },
      serveSpawn: fakeServe().spawn,
      libraryAssertApp: LIBRARY_ASSERT,
    });
    expect(src).toContain(`Logic.Burn(${D})`);
  });

  test("matches: A stopped alone, B stopped late (over 3000 ms) beside 7 busy loops; both rows and walls shown", async () => {
    const { f, events } = await run(stopped(2010), stopped(16000));
    expect(f?.verdict).toBe("matches");
    expect(events).toEqual([
      "call-A",
      ...Array(7).fill("burner-start"),
      "call-B",
      ...Array(7).fill("burner-kill"),
    ]);
    expect(f?.measured).toMatch(
      /A .*"durationMs":2010.*wall \d+ ms, cpu \d+ ms\); B .*"durationMs":16000.*wall \d+ ms, cpu \d+ ms/,
    );
    expect(f?.measured).toContain("Test exceeded 2s timeout.");
  });

  test("both calls are pinned to core 0, limit 2, with a process timeout", async () => {
    const { argvs, guards } = await run(stopped(2010), stopped(16000));
    expect(argvs).toHaveLength(2);
    for (const argv of argvs) {
      expect(argv.slice(0, 3)).toEqual(["/usr/bin/taskset", "-c", "0"]);
      expect(argv[argv.indexOf("--test-timeout-secs") + 1]).toBe("2");
    }
    expect(guards).toEqual([1, 1]);
  });

  test("the default process timeout is 60 s (unset hook)", async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const base = fakeV3();
    await runV3ContractProbe({
      alRunnerPath: "/fake/alrunner",
      expectedVersion: VERSION,
      packagesDir: "/fake/deps",
      bcVersion: BC,
      alcPath: "/fake/alc",
      alcIo: fakeAlcIo,
      tasksetPath: "/usr/bin/taskset",
      startBurner: () => ({ kill: () => {} }),
      spawn: async (argv, o) => {
        if (argv.includes("50656")) seen.push(o?.signal);
        return base(argv, o);
      },
      serveSpawn: fakeServe().spawn,
      libraryAssertApp: LIBRARY_ASSERT,
    });
    expect(seen).toHaveLength(2);
    for (const s of seen) expect(s).toBeDefined();
    expect(BURN_GUARD_MS).toBe(60_000);
  });

  test("a busy loop is `taskset -c 0 timeout -s KILL 150 sh -c ...` so a killed bun cannot orphan it", () => {
    expect(burnerArgv("/usr/bin/taskset")).toEqual([
      "/usr/bin/taskset",
      "-c",
      "0",
      "timeout",
      "-s",
      "KILL",
      "150",
      "sh",
      "-c",
      "while :; do :; done",
    ]);
  });

  test("diverged: A is not stopped (it passed: no limit at all), and B never runs", async () => {
    const { f, events } = await run(passed, stopped(16000));
    expect(f?.verdict).toBe("diverged");
    expect(events).toEqual(["call-A"]);
  });

  test("diverged: A killed by the process timeout (no limit stopped it), and B never runs", async () => {
    const { f, events } = await run("hang", stopped(16000));
    expect(f?.verdict).toBe("diverged");
    expect(f?.measured).toMatch(/killed by the 20 ms process timeout/);
    expect(events).toEqual(["call-A"]);
  });

  test("diverged: B stopped at durationMs 2050 (a wall-like stop)", async () => {
    const { f } = await run(stopped(2010), stopped(2050));
    expect(f?.verdict).toBe("diverged");
  });

  test("the 3000 ms line: 3000 diverges, 3001 matches (A short, so the relative rule is not the binding one)", async () => {
    expect((await run(stopped(1000), stopped(3000))).f?.verdict).toBe("diverged");
    expect((await run(stopped(1000), stopped(3001))).f?.verdict).toBe("matches");
  });

  test("diverged: a wall-time limit with slack stops both calls late (A 4000, B 4100)", async () => {
    expect((await run(stopped(4000), stopped(4100))).f?.verdict).toBe("diverged");
    expect((await run(stopped(2900), stopped(3100))).f?.verdict).toBe("diverged");
  });

  test("the relative line: B exactly 2x A diverges, just over matches", async () => {
    expect(BURN_RELATIVE_FACTOR).toBe(2);
    expect((await run(stopped(2500), stopped(5000))).f?.verdict).toBe("diverged");
    expect((await run(stopped(2500), stopped(5001))).f?.verdict).toBe("matches");
  });

  test("diverged: B passes (not stopped) although A was: the limit contract is broken", async () => {
    const { f } = await run(stopped(2010), passed);
    expect(f?.verdict).toBe("diverged");
    // Even when it ran long (over 3000 ms), a pass is not a timeout row.
    const long = {
      exitCode: 0,
      stdout: doc([row(50656, "CpuBurnLong", "pass", { durationMs: 9000 })]),
    };
    expect((await run(stopped(2010), long)).f?.verdict).toBe("diverged");
  });

  test("unmeasurable: B was killed by the process timeout even though its stdout holds a late timeout row", async () => {
    const { f } = await run(stopped(2010), "hang-rows");
    expect(f?.verdict).toBe("unmeasurable");
  });

  test("unmeasurable: B killed by the process timeout (cannot be read)", async () => {
    const { f, events } = await run(stopped(2010), "hang");
    expect(f?.verdict).toBe("unmeasurable");
    expect(events.filter((e) => e === "burner-kill")).toHaveLength(7);
  });

  test("unmeasurable: A has no row, and B has no row", async () => {
    expect((await run(noRows, stopped(16000))).f?.verdict).toBe("unmeasurable");
    expect((await run(stopped(2010), noRows)).f?.verdict).toBe("unmeasurable");
  });

  test("a busy loop already started is killed when the next one fails to start (finally)", async () => {
    const { events } = await run(stopped(2010), stopped(16000), 2);
    expect(events.filter((e) => e === "burner-start").length).toBe(1);
    expect(events.filter((e) => e === "burner-kill").length).toBe(1);
  });
});

describe("§8 the contract probe, continued", () => {
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
    expect(r.facts.length).toBe(38);
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
  const HUB_TEXT =
    "There was an error while executing the HTTP request, the connecting endpoint violates security requirements. Make sure you are connecting to a valid endpoint.";
  const LATER_FAIL = row(50653, "LaterFails", "fail", { message: "later" });
  const http = (o: Parameters<typeof row>[3], status = "fail") => row(50653, "HttpGet", status, o);
  const at50653 = (exitCode: number, rows: unknown[]) =>
    probe({ cu50653: () => ({ exitCode, stdout: doc(rows) }) });
  const verdictOf = (r: V3ContractResult, name: string) =>
    r.facts.find((f) => f.fact === name)?.verdict;
  const RRS = "refusal-row-shape";

  test("R705 ruling: the oracle is the test runner HUB text (a literal here, so the constant is checked)", () => {
    expect(BC_HTTP_HUB_TEXT).toBe(HUB_TEXT);
  });

  test("P1: refusal-row-shape reads gone on the hub's exact text, fail, exit 1; leg C held; no refusal", async () => {
    const r = await at50653(1, [http({ message: HUB_TEXT }), LATER_FAIL]);
    expect(r.facts.find((f) => f.fact === RRS)).toMatchObject({ kind: "defect", verdict: "gone" });
    expect(classifyLegC(r.facts, V3_DEFECT_FACTS, V3_LEG_C_FACTS).outcome).toBe("held");
    expect(v3ContractRefusals(r)).toEqual([]);
  });

  test("P2 (text): the hub text changed by a trailing space, a cut, a suffix or its case is never gone: unlike-bc; so is the web-service text (R705 ruling)", async () => {
    for (const m of [
      `${HUB_TEXT} `,
      HUB_TEXT.slice(0, -1),
      `${HUB_TEXT} more`,
      HUB_TEXT.toLowerCase(),
      BC_HTTP_INTERNAL_TEXT,
    ]) {
      const r = await at50653(1, [http({ message: m }), LATER_FAIL]);
      expect(verdictOf(r, RRS)).toBe("unlike-bc");
    }
  });

  test("P2 (fields): status error, notRun without the prefix, exit 7, a second HttpGet row, or the prefix with notRun false read diverged", async () => {
    const cases: Array<[number, unknown[]]> = [
      [1, [http({ message: HUB_TEXT }, "error"), LATER_FAIL]],
      [7, [http({ message: HUB_TEXT, notRun: true }, "error"), LATER_FAIL]],
      [7, [http({ message: HUB_TEXT }), LATER_FAIL]],
      [1, [http({ message: HUB_TEXT }), http({ message: HUB_TEXT })]],
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
  const PUB_FAIL = row(50654, "HttpGetPublic", "fail", { message: HUB_TEXT });
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

  // R-917: rows keep al-runner's stackTrace since R925; a row fact's measured text must not carry it,
  // or every pinned text (status and message only) stops matching and leg C holds a build that did not move.
  test("a row fact's measured text leaves out the row's stackTrace", async () => {
    const stacked = {
      ...row(50654, "LaterFails", "fail", { message: "later" }),
      stackTrace: "X line 2",
    };
    const f = (await at50654(1, [PUBLIC_REFUSED, stacked])).facts.find(
      (x) => x.fact === "refusal-cascade",
    );
    expect(f?.verdict).toBe("gone");
    expect(f?.measured).toContain('"message":"later"');
    expect(f?.measured).not.toContain("stackTrace");
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

  test("P10 (R590, r13; PR-114a; PR-340; PR-342): 38 facts, 9 defect, 18 contract, 1 warn, 10 capability-kind (8 + the carry fact + stop-groups); the old counts 37, 36 and 28 are gate-fail", async () => {
    const r = await probe();
    const kinds = (k: string) => r.facts.filter((f) => f.kind === k).length;
    expect([
      r.facts.length,
      kinds("defect"),
      kinds("contract"),
      kinds("warn"),
      kinds("capability"),
    ]).toEqual([38, 9, 18, 1, 10]);
    expect(V3_LEG_C_FACTS).toBe(38);
    expect(classifyLegC(r.facts, V3_DEFECT_FACTS, 37).outcome).toBe("gate-fail");
    expect(classifyLegC(r.facts, V3_DEFECT_FACTS, 36).outcome).toBe("gate-fail");
    expect(classifyLegC(r.facts, V3_DEFECT_FACTS, 28).outcome).toBe("gate-fail");
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

  // R705 ruling: a build that writes BC's web-service text is not the hub's reading: unlike-bc.
  const WS_ROWS = [http({ message: BC_HTTP_INTERNAL_TEXT }), LATER_FAIL];

  test("P12: a web-service-text row is unlike-bc: gate-fail in leg C (#5700); a CANDIDATE session warns and runs", async () => {
    const r = await at50653(1, WS_ROWS);
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
    const r = await at50653(1, WS_ROWS);
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

  // R860 (upstream #7139): the text edge a461e6310 wrote, measured with its binary.
  const STOP_STDERR =
    "note: the app's runtime is 13.0, older than 16.0, the oldest AL Runner knows the members of: a call the docs do not list for runtime 13.0 is not run\nerror: 1 dependency app(s) were not found and --no-download is set, so the run would use a different install than a run with the apps:\n  dependency `LethAL R590 Absent` by LethAL (7a1c0e52-5b8e-4d3a-9f60-2c7b8e1d2590) version 1.0.0.0 or higher was not found; searched: /fake/pkgs, proj/app/.alpackages, proj/tests/.alpackages; put its .app with AL source (or its source archive) in the project's .alpackages or pass --dep DIR\nAdd the app to a --dep folder or the cache, or pass --allow-missing-dependencies to skip it with a warning.\n";

  test("R860: a reworded header, or other exit-2 text naming the app, is diverged (the fact reads what the backend stops on)", async () => {
    for (const text of [
      STOP_STDERR.replace("dependency app(s) were not found", "dependencies are absent"),
      "error: dependency cycle: `LethAL R590 Absent` by LethAL\n",
    ]) {
      const r = await probe({ cu50662: runs(text, 2) });
      expect(r.facts.find((f) => f.fact === F)?.verdict).toBe("diverged");
    }
  });

  test("R860: the new form (exit 2, stderr names the app) matches too, and leg C passes", async () => {
    const r = await probe({ cu50662: runs(STOP_STDERR, 2) });
    expect(r.facts.find((f) => f.fact === F)?.verdict).toBe("matches");
    expect(classifyLegC(r.facts, V3_DEFECT_FACTS, V3_LEG_C_FACTS).outcome).toBe("pass");
  });

  test("R860: exit 2 without the app's name, exit 0 with no line, and the name with exit 1 all diverge", async () => {
    const r = await probe({
      cu50662: runs("error: 1 dependency app(s) were not found and --no-download is set\n", 2),
    });
    expect(r.facts.find((f) => f.fact === F)?.verdict).toBe("diverged");
    const quiet = await probe({ cu50662: runs("", 0) });
    expect(quiet.facts.find((f) => f.fact === F)?.verdict).toBe("diverged");
    const one = await probe({ cu50662: runs(STOP_STDERR, 1) });
    expect(one.facts.find((f) => f.fact === F)?.verdict).toBe("diverged");
  });

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

  test("PR-117: .gated carries batchFacts, only verdicts kept; a row without the field parses unchanged", () => {
    const base = { version: "v", binarySha256: "a".repeat(64), lethalCommit: COMMIT };
    expect(
      parseGated(
        JSON.stringify({
          ...base,
          batchFacts: { "batch-no-cross-row": "matches", b: "pass", c: 1 },
        }),
        "x",
      ).batchFacts,
    ).toEqual({ "batch-no-cross-row": "matches" });
    const none = parseGated(JSON.stringify(base), "x");
    expect("batchFacts" in none).toBe(false);
    expect(
      "batchFacts" in parseGated(JSON.stringify({ ...base, batchFacts: { b: "pass" } }), "x"),
    ).toBe(false);
  });

  test("PR-342: a record's batchFacts keep stop-groups' reading, matches or diverged, beside the eight", () => {
    const base = { version: "v", binarySha256: "a".repeat(64), lethalCommit: COMMIT };
    for (const v of ["matches", "diverged"])
      expect(
        parseGated(
          JSON.stringify({
            ...base,
            batchFacts: { "batch-no-cross-row": "matches", [STOP_GROUPS_FACT]: v },
          }),
          "x",
        ).batchFacts,
      ).toEqual({ "batch-no-cross-row": "matches", "stop-groups": v });
  });
});

describe("PR-340: the carry fact batch-sequential-carry", () => {
  const spawnsWithEnv = () => {
    const serve = fakeServe();
    const envs: (Readonly<Record<string, string | undefined>> | undefined)[] = [];
    const spawn: ServerSpawnFn = (argv, opts) => {
      envs.push(opts?.env);
      return serve.spawn(argv, opts);
    };
    return { spawn, envs, serve };
  };

  // Test 8, leg C half. Red (a): drop `serverEnv` from the carry spec in BATCH_FACTS, so its server
  // does not get the variable. Red (b): put AL_STRICT_SEQUENTIAL into `v3ChildEnv`, so every server does.
  test("only the carry fact's OWN server gets AL_STRICT_SEQUENTIAL=1; serve-keep-reasons' and the eight facts' servers do not", async () => {
    const before = process.env.AL_STRICT_SEQUENTIAL;
    try {
      // S2: judged on the env each spawn REALLY gets (merged over the ambient one), whatever the ambient value.
      // Red: `mergeChildEnv` not dropping the ambient variable puts "0" or "1" on the first two servers.
      for (const ambient of ["0", "1", undefined]) {
        if (ambient === undefined) Reflect.deleteProperty(process.env, "AL_STRICT_SEQUENTIAL");
        else process.env.AL_STRICT_SEQUENTIAL = ambient;
        const { spawn, envs } = spawnsWithEnv();
        const r = await probe({}, spawn);
        expect(r.facts.find((f) => f.fact === V3_CARRY_FACT)?.verdict).toBe("matches");
        // serve-keep-reasons, the eight facts', the carry fact's, then (PR-342) stop-groups'.
        // PR-363: serve-keep-reasons' own and its V3_KEEP_APP_FAMILIES family daemons come first, all without the variable.
        expect(envs).toHaveLength(3 + 1 + V3_KEEP_APP_FAMILIES);
        expect(
          envs.map((e) => mergeChildEnv(e ?? {}).AL_STRICT_SEQUENTIAL),
          `ambient ${ambient}`,
        ).toEqual([
          ...Array.from({ length: 1 + V3_KEEP_APP_FAMILIES }, () => undefined),
          undefined,
          "1",
          undefined,
        ]);
      }
    } finally {
      if (before === undefined) Reflect.deleteProperty(process.env, "AL_STRICT_SEQUENTIAL");
      else process.env.AL_STRICT_SEQUENTIAL = before;
    }
  });

  // Red: judge the reader `pass` as `matches` (loosen the judge), or drop the reader-status check.
  test("a build that does NOT carry (the reader passes) reads diverged; the other facts and a session are untouched, the gate fails", async () => {
    const serve = fakeServe(SERVE_ROWS, {
      cap: (fact, _q, def) =>
        fact === V3_CARRY_FACT && "tests" in def
          ? { ...def, tests: def.tests.map((t) => ({ ...t, status: "pass", message: undefined })) }
          : def,
    });
    const r = await probe({}, serve.spawn);
    const f = (n: string) => r.facts.find((x) => x.fact === n);
    expect(f(V3_CARRY_FACT)?.verdict).toBe("diverged");
    for (const n of V3_CAPABILITY_FACTS) expect(f(n)?.verdict, n).toBe("matches");
    expect(v3ContractRefusals(r)).toEqual([]);
    expect(classifyLegC(r.facts, V3_DEFECT_FACTS, V3_LEG_C_FACTS).outcome).toBe("gate-fail");
  });

  test("an empty answer is not a match", async () => {
    const serve = fakeServe(SERVE_ROWS, {
      cap: (fact, _q, def) =>
        fact === V3_CARRY_FACT && "tests" in def ? { ...def, tests: [] } : def,
    });
    const r = await probe({}, serve.spawn);
    expect(r.facts.find((x) => x.fact === V3_CARRY_FACT)?.verdict).toBe("diverged");
  });

  // Test 7 (the gate half, amendment 1): this session's probe must read matches, and a record of the fact
  // must not say otherwise; a record WITHOUT the fact does not block. Red: drop the probe check (the
  // `bad` and `undefined` cases), or drop the `was !== undefined &&` guard (the no-record cases).
  test("carryWalkOffReason: this session's probe must read matches; a recorded diverged wins; a missing record does not block", async () => {
    const r = await probe();
    const lethalCommit = "a".repeat(40);
    const eight = Object.fromEntries(V3_CAPABILITY_FACTS.map((n) => [n, "matches"]));
    expect(carryWalkOffReason(r, { batchFacts: eight, lethalCommit })).toBeUndefined();
    expect(carryWalkOffReason(r, undefined)).toBeUndefined();
    const full = { ...eight, [V3_CARRY_FACT]: "matches" };
    expect(carryWalkOffReason(r, { batchFacts: full, lethalCommit })).toBeUndefined();
    expect(
      carryWalkOffReason(r, {
        batchFacts: { ...eight, [V3_CARRY_FACT]: "diverged" },
        lethalCommit,
      }),
    ).toContain("diverged");
    const bad = {
      ...r,
      facts: r.facts.map((f) => (f.fact === V3_CARRY_FACT ? { ...f, verdict: "diverged" } : f)),
    } as V3ContractResult;
    expect(carryWalkOffReason(bad, { batchFacts: full, lethalCommit })).toContain("probe read");
    expect(carryWalkOffReason(bad, undefined)).toContain("probe read");
    expect(carryWalkOffReason(undefined, { batchFacts: full, lethalCommit })).toContain(
      "unmeasured",
    );
    expect(carryWalkOffReason(undefined, undefined)).toContain("unmeasured");
    // The record rule of baseline batching names none of this fact.
    expect(
      baselineBatchingOffReason(r, "v", "b".repeat(64), { batchFacts: eight, lethalCommit }) ?? "",
    ).not.toContain(V3_CARRY_FACT);
  });
});

describe("PR-342: the stop-groups capability fact (PR-256's alRunnerV3.stopGroups)", () => {
  type R = { name: string; status: string; notRun?: boolean; message?: string };
  const rows = (rs: R[]): StopAnswer => ({
    rows: rs.map((r) => ({
      name: r.name,
      status: r.status,
      notRun: r.notRun === true,
      message: r.message,
    })),
  });
  /** What a #8564 build answers (PR-257's text), straight from the fake daemon's model. */
  const asBuilt = (): { stop: StopAnswer; follow: StopAnswer; guard: StopAnswer } => {
    const of = (q: Record<string, unknown>) =>
      rows(
        (stopGroupsAnswer(q) as { tests: Record<string, unknown>[] }).tests.map((t) => ({
          name: String(t.name),
          status: String(t.status),
          notRun: t.notRun === true,
          ...(typeof t.message === "string" ? { message: t.message } : {}),
        })),
      );
    return {
      stop: of(STOP_GROUPS_REQUESTS.stop),
      follow: of(STOP_GROUPS_REQUESTS.follow),
      guard: of(STOP_GROUPS_REQUESTS.guard),
    };
  };
  const replace = (a: StopAnswer, name: string, r: Omit<R, "name">): StopAnswer =>
    rows(
      ("rows" in a ? a.rows : []).map((x) =>
        x.name === name
          ? { name, ...r }
          : {
              name: x.name,
              status: x.status,
              notRun: x.notRun,
              ...(x.message !== undefined ? { message: x.message } : {}),
            },
      ),
    );
  const SKIP_FIRST = skipText("Codeunit50781.First", "a");

  test("case 1, 4, 5 as #8564 gives them: matches; the guard readings are recorded as ran", () => {
    const j = judgeStopGroups(asBuilt());
    expect(j.verdict).toBe("matches");
    expect(j.measured).toContain("after a timeout: ran; after a refusal: ran");
  });

  test("a build without #8564 refuses the request by name: diverged (fails closed), the refusal recorded", () => {
    const refused: StopAnswer = {
      refused:
        'al-runner serve: the request was refused: "unknown field `stopGroup` in an entry of `entries`"',
    };
    const j = judgeStopGroups({ ...asBuilt(), stop: refused });
    expect(j.verdict).toBe("diverged");
    expect(j.measured).toContain("unknown field `stopGroup`");
  });

  test("case 1: a build that runs the second test (no skip) is diverged", () => {
    const a = asBuilt();
    const stop = replace(
      replace(a.stop, "Codeunit50781.Second", { status: "pass" }),
      "Codeunit50782.Other",
      { status: "pass" },
    );
    expect(judgeStopGroups({ ...a, stop }).verdict).toBe("diverged");
  });

  test("review nit: a doubled skip row (two rows of one name) is diverged, never matched on its first copy", () => {
    const a = asBuilt();
    const rs = "rows" in a.stop ? a.stop.rows : [];
    const second = rs.find((x) => x.name === "Codeunit50781.Second");
    expect(second).toBeDefined();
    if (second === undefined) return;
    const stop: StopAnswer = { rows: [...rs, second] };
    expect(judgeStopGroups({ ...a, stop }).verdict).toBe("diverged");
  });

  test("case 1: a skip of the SECOND ENTRY missing (only the codeunit's own rest) is diverged", () => {
    const a = asBuilt();
    const stop = replace(a.stop, "Codeunit50782.Other", { status: "pass" });
    expect(judgeStopGroups({ ...a, stop }).verdict).toBe("diverged");
  });

  test("case 1: the skip text naming another test, or reworded, is diverged", () => {
    const a = asBuilt();
    for (const message of [
      skipText("Codeunit50783.Passes", "a"),
      SKIP_FIRST.replace("NotRun: out-of-scope: ", "NotRun: "),
    ]) {
      const stop = replace(a.stop, "Codeunit50781.Second", {
        status: "error",
        notRun: true,
        message,
      });
      expect(judgeStopGroups({ ...a, stop }).verdict).toBe("diverged");
    }
  });

  test("case 1: the skip text on a row that is not notRun/error is diverged", () => {
    const a = asBuilt();
    const stop = replace(a.stop, "Codeunit50781.Second", { status: "fail", message: SKIP_FIRST });
    expect(judgeStopGroups({ ...a, stop }).verdict).toBe("diverged");
  });

  test("case 1: a first test that is not a plain fail is diverged", () => {
    const a = asBuilt();
    const stop = replace(a.stop, "Codeunit50781.First", {
      status: "fail",
      notRun: true,
      message: "first fails",
    });
    expect(judgeStopGroups({ ...a, stop }).verdict).toBe("diverged");
  });

  test("case 5: group a's failure skipping group b's test is diverged", () => {
    const a = asBuilt();
    const stop = replace(a.stop, "Codeunit50783.Passes", {
      status: "error",
      notRun: true,
      message: SKIP_FIRST,
    });
    expect(judgeStopGroups({ ...a, stop }).verdict).toBe("diverged");
  });

  test("case 4: the follow-up request not answered normally: diverged on a row, unmeasurable on no answer", () => {
    const a = asBuilt();
    expect(
      judgeStopGroups({
        ...a,
        follow: replace(a.follow, "Codeunit50783.Passes", { status: "fail" }),
      }).verdict,
    ).toBe("diverged");
    expect(judgeStopGroups({ ...a, follow: rows([]) }).verdict).toBe("diverged");
    expect(judgeStopGroups({ ...a, follow: { refused: "busy" } }).verdict).toBe("diverged");
    expect(judgeStopGroups({ ...a, follow: { failed: "deadline" } }).verdict).toBe("unmeasurable");
    expect(judgeStopGroups({ ...a, stop: { failed: "eof" } }).verdict).toBe("unmeasurable");
  });

  test("cases 2 and 3: a skip after a timeout or a refusal row is RECORDED, and never changes the verdict", () => {
    const a = asBuilt();
    const guard = replace(
      replace(a.guard, "Codeunit50784.After", {
        status: "error",
        notRun: true,
        message: skipText("Codeunit50784.Spins", "t"),
      }),
      "Codeunit50785.After",
      { status: "error", notRun: true, message: skipText("Codeunit50785.Refuses", "r") },
    );
    const j = judgeStopGroups({ ...a, guard });
    expect(j.verdict).toBe("matches");
    expect(j.measured).toContain("after a timeout: SKIPPED; after a refusal: SKIPPED");
    // a guard first row that is not what it claims to test is named, too
    const notTimeout = replace(a.guard, "Codeunit50784.Spins", { status: "pass" });
    expect(judgeStopGroups({ ...a, guard: notTimeout }).measured).toContain(
      "after a timeout (first row not a timeout): ran",
    );
    expect(judgeStopGroups({ ...a, guard: { failed: "deadline" } }).verdict).toBe("matches");
  });

  test("the probe sends the three requests to ONE daemon, in order, with the pinned shapes, and reads matches", async () => {
    const serve = fakeServe();
    const r = await probe({}, serve.spawn);
    const f = r.facts.find((x) => x.fact === STOP_GROUPS_FACT);
    expect(f).toMatchObject({ kind: "capability", verdict: "matches" });
    const sent = serve.requests.filter(isStopGroupsRequest);
    expect(sent.map(({ sourcePaths: _, ...q }) => q)).toEqual([
      { command: "runTests", testIsolation: "test", ...STOP_GROUPS_REQUESTS.stop },
      { command: "runTests", testIsolation: "test", ...STOP_GROUPS_REQUESTS.follow },
      { command: "runTests", testIsolation: "test", ...STOP_GROUPS_REQUESTS.guard },
    ]);
    expect(STOP_GROUPS_REQUESTS.stop.entries.every((e) => e.stopGroup !== undefined)).toBe(true);
    expect("stopAfterFirstFailure" in STOP_GROUPS_REQUESTS.follow).toBe(false);
  });

  test("the probe on a build that refuses `stopGroup` reads diverged, and leg C still passes with the off line", async () => {
    const serve = fakeServe(SERVE_ROWS, {
      cap: (fact, _q, def) =>
        fact === "stop-groups"
          ? { error: "unknown field `stopGroup` in an entry of `entries`" }
          : def,
    });
    const r = await probe({}, serve.spawn);
    expect(r.facts.find((x) => x.fact === STOP_GROUPS_FACT)?.verdict).toBe("diverged");
    const c = classifyLegC(
      r.facts,
      V3_DEFECT_FACTS,
      V3_LEG_C_FACTS,
      V3_WARN_FACTS,
      undefined,
      V3_CAPABILITY_FACTS,
    );
    expect(c.outcome).toBe("pass");
    expect(
      c.lines.some((l) => l.startsWith("al-runner-v3-stop-groups-off: stop-groups: diverged")),
    ).toBe(true);
  });

  test("leg C: stop-groups matches passes with no line; unmeasurable is infra-fail; another fact's diverged still fails", () => {
    const one = (fact: string, verdict: string) => [{ fact, verdict, measured: "m" }];
    expect(classifyLegC(one("stop-groups", "matches"), [], 1)).toEqual({
      outcome: "pass",
      lines: [],
    });
    expect(classifyLegC(one("stop-groups", "unmeasurable"), [], 1).outcome).toBe("infra-fail");
    expect(classifyLegC(one("version", "diverged"), [], 1).outcome).toBe("gate-fail");
  });

  test("a session (gate-only) never measures stop-groups", async () => {
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
    expect(r.facts.some((x) => x.fact === STOP_GROUPS_FACT)).toBe(false);
    expect(s.requests.some(isStopGroupsRequest)).toBe(false);
  });
});

describe("PR-363: serve-keep-reasons' per-family apps, each on its own fresh daemon, judged on its own rows", () => {
  const keepFact = (r: V3ContractResult) => r.facts.find((x) => x.fact === "serve-keep-reasons");
  const OTHER = { name: "Codeunit51002.Other", status: "error", notRun: true } as const;

  // Red: judge `rows` merged across requests (find the case in the first request that has the name).
  test("each request is judged on its OWN rows: two families return the same test name with different outcomes", async () => {
    const s = fakeServe(SERVE_ROWS, {
      family: (dir) =>
        dir.endsWith("/fam1") ? [{ name: KEEP_CASE.name, status: "pass" }] : keptRows(dir),
    });
    const f = keepFact(await probe({}, s.spawn));
    expect(f?.verdict).toBe("diverged");
    expect(f?.measured).toContain("fam1 stream-never-created: MOVED pass");
    expect(f?.measured).not.toContain("fam0");
    expect(f?.measured.split("; ")).toHaveLength(1);
  });

  // Red: start the family daemon once, outside the loop in serveKeepReasons (a shared daemon).
  test("each family gets a FRESH daemon: one process per request, the same argv as the first", async () => {
    const inner = fakeServe();
    const procs: string[][] = [];
    const spawn: ServerSpawnFn = (argv, opts) => {
      const p = inner.spawn(argv, opts);
      const mine: string[] = [];
      procs.push(mine);
      return {
        ...p,
        write: (line: string) => {
          const q = JSON.parse(line) as { command: string; sourcePaths?: string[] };
          if (q.command === "runTests") mine.push(String(q.sourcePaths?.[0]));
          p.write(line);
        },
      };
    };
    await probe({}, spawn);
    // process 0 is the existing request; 1..N each hold exactly one request, for their own app
    expect(procs.slice(1, 1 + V3_KEEP_APP_FAMILIES)).toEqual(KEEP_APPS.map((a) => [a.dir]));
    expect(procs[0]).toHaveLength(1);
    expect(procs[0]?.[0]).not.toContain(FAKE_KEEP_DIR);
    const serveArgv = [resolve("/fake/alrunner"), "serve", "--test-timeout", "3"];
    expect(inner.argvs.slice(0, 1 + V3_KEEP_APP_FAMILIES)).toEqual(
      Array.from({ length: 1 + V3_KEEP_APP_FAMILIES }, () => serveArgv),
    );
  });

  const raw = (keepApps?: readonly V3KeepApp[]) => {
    const s = fakeServe();
    return runV3ContractProbeRaw({
      ...(keepApps !== undefined ? { keepApps } : {}),
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
      libraryAssertApp: LIBRARY_ASSERT,
    }).then((r) => ({ r, s }));
  };

  // Red: delete the `keepApps === undefined || keepApps.length < V3_KEEP_APP_FAMILIES` check in serveKeepReasons.
  test("the family apps absent, or fewer than the pinned count: unmeasurable, the reason named, no request made for it", async () => {
    for (const apps of [undefined, KEEP_APPS.slice(0, V3_KEEP_APP_FAMILIES - 1)]) {
      const { r, s } = await raw(apps);
      const f = keepFact(r);
      expect(f?.verdict).toBe("unmeasurable");
      expect(f?.measured).toContain("the family apps are missing");
      expect(f?.measured).toContain(
        apps === undefined ? "none given" : `9 of ${V3_KEEP_APP_FAMILIES}`,
      );
      // never the old request alone: serve-keep-reasons ran no request at all
      expect(
        s.requests.some(
          (q) => q.command === "runTests" && !isCapabilityRequest(q) && !isStopGroupsRequest(q),
        ),
      ).toBe(false);
    }
  });

  // Red: judge only the chosen cases (drop the `(unjudged)` loop over the request's other rows).
  test("a refused row in a family request that no entry keeps is unkept, named by family, and fails leg C", async () => {
    const s = fakeServe(SERVE_ROWS, {
      family: (dir) => [
        ...keptRows(dir),
        ...(dir.endsWith("/fam3")
          ? [{ ...OTHER, message: "NotRun: out-of-scope: a reworded refusal nobody keeps" }]
          : []),
      ],
    });
    const r = await probe({}, s.spawn);
    const f = keepFact(r);
    expect(f?.verdict).toBe("unkept");
    expect(f?.measured).toContain("fam3 (unjudged): UNKEPT Codeunit51002.Other");
    expect(classifyLegC(r.facts, V3_DEFECT_FACTS, V3_LEG_C_FACTS, V3_WARN_FACTS).outcome).toBe(
      "gate-fail",
    );
  });

  // Red: let a chosen case's refusal that its OWN entry does not match fall to `moved` only (drop the unkeptRefusal check).
  test("a chosen case whose refusal text no entry keeps is unkept (a reworded entry), not merely moved", async () => {
    const s = fakeServe(SERVE_ROWS, {
      family: (dir) =>
        dir.endsWith("/fam7")
          ? [
              {
                name: KEEP_CASE.name,
                status: "error",
                notRun: true,
                message: `${KEEP_TEXT} (reworded)`,
              },
            ]
          : keptRows(dir),
    });
    const f = keepFact(await probe({}, s.spawn));
    expect(f?.verdict).toBe("unkept");
    expect(f?.measured).toContain("fam7 stream-never-created: UNKEPT");
  });

  // Red: drop the `res.tests.length === 0` branch (every case would then read MOVED, a mere warning).
  test("a family request with no row at all is unmeasurable, naming the family and its compilationErrors", async () => {
    const s = fakeServe(SERVE_ROWS, {
      family: (dir) => (dir.endsWith("/fam5") ? [] : keptRows(dir)),
    });
    const f = keepFact(await probe({}, s.spawn));
    expect(f?.verdict).toBe("unmeasurable");
    expect(f?.measured).toContain("fam5: the request returned no test row at all");
    expect(f?.measured).toContain("compilationErrors");
  });

  // Red: accept a plain fail or pass for a family case (copy the SERVE_CASES allowances into the family loop).
  test("a family case that fails plainly (the refusal moved) reads diverged: refusal only", async () => {
    const s = fakeServe(SERVE_ROWS, {
      family: (dir) =>
        dir.endsWith("/fam2")
          ? [{ name: KEEP_CASE.name, status: "fail", message: "some plain failure" }]
          : keptRows(dir),
    });
    const f = keepFact(await probe({}, s.spawn));
    expect(f?.verdict).toBe("diverged");
    expect(f?.measured).toContain("fam2 stream-never-created: MOVED fail");
  });

  // Build review S1. Red: swap `unmeasurable` and `diverged` in the verdict order (a blind family would then pass as a warning).
  test("a family with no row beside another family's moved case reads unmeasurable, not diverged", async () => {
    const s = fakeServe(SERVE_ROWS, {
      family: (dir) =>
        dir.endsWith("/fam5")
          ? []
          : dir.endsWith("/fam2")
            ? [{ name: KEEP_CASE.name, status: "pass" }]
            : keptRows(dir),
    });
    const f = keepFact(await probe({}, s.spawn));
    expect(f?.verdict).toBe("unmeasurable");
    expect(f?.measured).toContain("fam5: the request returned no test row at all");
    expect(f?.measured).toContain("fam2 stream-never-created: MOVED pass"); // build review L2: moved rows still shown
  });

  // Build review S1. Red: put `unmeasurable` before `unkept` in the verdict order.
  test("a family with no row beside another family's unkept row reads unkept", async () => {
    const s = fakeServe(SERVE_ROWS, {
      family: (dir) =>
        dir.endsWith("/fam5")
          ? []
          : dir.endsWith("/fam3")
            ? [
                ...keptRows(dir),
                { ...OTHER, message: "NotRun: out-of-scope: a reworded refusal nobody keeps" },
              ]
            : keptRows(dir),
    });
    const f = keepFact(await probe({}, s.spawn));
    expect(f?.verdict).toBe("unkept");
    expect(f?.measured).toContain("fam3 (unjudged): UNKEPT Codeunit51002.Other");
  });

  // Build review L1. Red: drop the case-count half of the manifest check.
  test("a manifest with the right family count but the wrong case count reads unmeasurable before any request", async () => {
    const short = KEEP_APPS.map((a, i) => (i === 0 ? { ...a, cases: [KEEP_CASE] } : a));
    const { r } = await raw(short);
    const f = keepFact(r);
    expect(f?.verdict).toBe("unmeasurable");
    expect(f?.measured).toContain(`10 of 10 families, 10 of ${V3_KEEP_CASES} cases`);
  });
});
