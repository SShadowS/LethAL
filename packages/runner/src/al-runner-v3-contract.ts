/**
 * R586 §8 (plan `docs/superpowers/plans/2026-10-21-r586-alrunner-v3-backend.md`; r2 §8 with r3 and
 * r4's changes): the al-runner v3 contract probe, R123-style. Run once per session by
 * `AlRunnerV3Backend.status()` after the version and `.gated` checks, and as leg C of
 * `itest:alrunner-v3`. Every probe project is generated here (invented AL) into a scratch folder.
 *
 * Two kinds of fact:
 * - `contract`: `matches` / `diverged` / `unmeasurable`. Anything but `matches` refuses the session,
 *   as R123 does: the verdicts would be decoded under assumptions that no longer hold.
 * - `defect`: a known upstream defect, `defect-present` / `gone` / `unmeasurable`. `gone` never
 *   refuses; it prints `al-runner-v3-defect-gone` and changes no capability until a human
 *   re-measures and pre-commits (plan §6, §7). R639 (r9) adds `refused` (v3 declines a case BC
 *   fails: held, only warns) and `unlike-bc` (`refusal-row-shape` only: refuses a normal session,
 *   warns in the update gate's candidate legs, gate-fail in leg C).
 * - `warn` (R612, plan r3 §2): `serve-keep-reasons`. Never refuses and never fails the gate; a
 *   non-`matches` reading prints `al-runner-v3-serve-keep-reason-moved` (`V3_WARN_FACTS`).
 */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isV3RefusalText } from "./al-runner-rows";
import {
  AlRunnerServer,
  type ServerSpawnFn,
  type ServerTestLine,
  V3_SERVE_SAFE_REFUSALS,
  defaultServerSpawn,
} from "./al-runner-server";
import {
  type V3Row,
  V3_REFUSAL_PREFIX,
  decodeV3Rows,
  v3DependencySkipLines,
} from "./al-runner-v3-backend";
import { baseAppJson, probeV3PredefinedSymbols } from "./al-runner-v3-probe";
import { BC_HTTP_HUB_TEXT } from "./al-runner-v3-texts";
import { AlcCompileError, ArtifactCompiler, type ArtifactIo, defaultArtifactIo } from "./artifact";
import { type SpawnFn, absToolPath, defaultSpawn } from "./publisher";

/**
 * R675: the start each leg-C probe message must have, from LethAL's own probe AL (`Error('boom %1',
 * 5)`; `Assert.AreEqual(1, 2, ...)`). R657 measured v3 writing no text before them; the fact
 * `message-has-no-type-prefix` notices a build that adds ANY text there, of any shape.
 */
const PROBE_MESSAGE_START = { Fails: "boom 5", AssertAreEqual: "Assert.AreEqual failed." } as const;

/** R667: a contract fact: `gate-fail` in leg C, a refusal in a session. */
export const MESSAGE_PREFIX_FACT = "message-has-no-type-prefix";

/**
 * R667 (review r1), R672, R675 (plan §1f): why a prefix refuses a session, not only skews the R553
 * screen.
 */
export const MESSAGE_PREFIX_REASON =
  "text before, or in place of, the expected start of v3's failure messages (a `<Type>:` prefix of any shape) would turn v3's timeouts into errors (`V3_TIMEOUT_MESSAGE` is anchored), close the serve daemon on every refusal (R612's keep list is anchored), and skew the R553 assertion screen. K1(a) and the serve-keep rule read v3's refusal marker anywhere in a message (R675), so a prefix cannot turn a refusal into a kill; the session still refuses, because v3 no longer writes what was measured";

export type V3ContractVerdict = "matches" | "diverged" | "unmeasurable";
/**
 * R639 (pre-commitment r9): `refused` (v3 declines; not BC's reading: held, never gone) and
 * `unlike-bc` (`refusal-row-shape` only: v3 fails as BC does, with another text; #5700).
 */
export type V3DefectVerdict = "defect-present" | "gone" | "unmeasurable" | "refused" | "unlike-bc";

/**
 * r9: BC's own texts, measured on bc1 (BC 28.4, `docs/measurements/r639/bc1-probe.json`), compared
 * byte for byte (no trim, no case folding, no prefix match). `r639-bc-readings.test.ts` binds each to
 * that file. HTTP: 92911's `raw` and 92910's first line, both `fail`.
 */
export const BC_HTTP_INTERNAL_TEXT =
  "The request was blocked by the runtime to prevent accidental use of production services.";
/**
 * R705 (owner ruling 2026-10-24): the oracle for HTTP-in-test behaviour is BC's TEST RUNNER HUB path
 * (VS Code, `bcdev_test_run`), not the web-service path. R706 measured the hub on bc1: this text, code
 * `HttpRequest:Security`. `refusal-row-shape` reads `gone` on exactly this text.
 * `BC_HTTP_INTERNAL_TEXT` above is BC's web-service-path text (r639, R706); it is kept, and a build that
 * writes it now reads `unlike-bc`, as any text other than the hub's does.
 */
export { BC_HTTP_HUB_TEXT };
/** Duplicate key at the end of a test: 92912's `DuplicateNamedKey`, 92913, and 92915's `raw`. */
export const BC_END_OF_TEST_TEXT =
  "The record in table Probe Row already exists. Identification fields and values: Key='K1'";

/** r9: a v3 refusal row, exactly: `notRun`, `status: "error"`, `NotRun: out-of-scope: <reason>`. */
export function isRefusalRow(r: V3Row | undefined): boolean {
  return (
    r !== undefined &&
    r.notRun === true &&
    r.status === "error" &&
    (r.message ?? "").startsWith(`${V3_REFUSAL_PREFIX} `)
  );
}

/** r9: the exit a call must give for its rows: 1 for any plain fail, else 7 for any notRun, else 0. */
export function impliedExit(rows: readonly V3Row[]): number {
  if (rows.some((r) => r.status === "fail" && !r.notRun)) return 1;
  return rows.some((r) => r.notRun) ? 7 : 0;
}

/** r9 §2: `refusal-row-shape` (#5608) on 50653's call. */
function refusalRowShape(c: {
  readonly exitCode: number;
  readonly rows: readonly V3Row[] | undefined;
}): V3DefectVerdict | "diverged" {
  if (c.rows === undefined) return "unmeasurable";
  const hs = c.rows.filter((r) => r.method === "HttpGet");
  const h = hs.length === 1 ? hs[0] : undefined;
  if (h === undefined || c.exitCode !== impliedExit(c.rows)) return "diverged";
  if (isRefusalRow(h)) return "defect-present";
  const m = h.message ?? "";
  if (h.status !== "fail" || h.notRun || c.exitCode !== 1) return "diverged";
  if (m === BC_HTTP_HUB_TEXT) return "gone";
  return isV3RefusalText(m) ? "diverged" : "unlike-bc";
}

export interface V3Fact {
  readonly fact: string;
  /** `warn` (R612): never refuses a session or fails the gate; only prints its line. */
  readonly kind: "contract" | "defect" | "warn";
  readonly verdict: V3ContractVerdict | V3DefectVerdict;
  readonly expected: string;
  readonly measured: string;
}

export interface V3ContractResult {
  readonly facts: readonly V3Fact[];
}

const TARGET_ID = "7a1c0e52-5b8e-4d3a-9f60-2c7b8e1d0586";
const TESTS_ID = "7a1c0e52-5b8e-4d3a-9f60-2c7b8e1d1586";
const TARGET_NAME = "LethAL R586 Contract App";

/**
 * `sleep-is-noop` (#5605, pre-commitment r6) on one call of codeunit 50660:
 * - `defect-present`: the call is under 1 s, every Sleep row passes with durationMs under 100, AND
 *   `LongSleepThenAssert` passes (Sleep returned at once and advanced the AL clock);
 * - `gone`: a Sleep test took its real time (durationMs >= 1000) or was stopped as a timeout row
 *   (notRun, "Test exceeded ..."): upstream's proposed fix (slept time counts toward the timeout);
 * - `diverged`: anything else, e.g. fast but the clock not advanced. Never `matches`.
 */
export function classifySleep(cl: {
  readonly rows: readonly V3Row[] | undefined;
  readonly wallMs: number;
}): V3DefectVerdict | "diverged" {
  if (cl.rows === undefined) return "unmeasurable";
  const rows = cl.rows;
  const sleeps = ["ShortSleep", "LongSleepA", "LongSleepB", "LongSleepThenAssert"].map((m) =>
    rows.find((r) => r.method === m),
  );
  const present = sleeps.filter((r): r is V3Row => r !== undefined);
  if (
    present.some(
      (r) => (r.durationMs ?? 0) >= 1000 || (r.notRun && /^Test exceeded/.test(r.message ?? "")),
    )
  )
    return "gone";
  if (present.length !== sleeps.length) return "unmeasurable";
  const instant =
    cl.wallMs < 1000 && present.every((r) => r.durationMs !== undefined && r.durationMs < 100);
  return instant && present.every((r) => r.status === "pass" && !r.notRun)
    ? "defect-present"
    : "diverged";
}

/**
 * `timeout-is-cpu` (r14b, R693): CPU speed varies too much to size a burn (r6's fixed counts and r14's
 * calibration both flipped with core-0 conditions), so ONE burn is used that never finishes in any
 * budget here. Call A, pinned and alone, must be stopped at the limit. Call B, the same burn pinned
 * beside BURN_BUSY_LOOPS busy loops (the burn gets about 1/8 of the core), must ALSO be stopped, but
 * late in wall time: a CPU-time stop comes after the limit in CPU (about 8x that in wall), a
 * wall-time stop at the limit. B's durationMs must exceed BURN_WALL_FACTOR x the limit AND
 * BURN_RELATIVE_FACTOR x A's durationMs (a wall-time limit with slack stops both at the same time;
 * healthy runs give B about 8x A).
 */
export const BURN_HUGE = 2_000_000_000;
export const BURN_LIMIT_SECS = 2;
export const BURN_BUSY_LOOPS = 7;
export const BURN_WALL_FACTOR = 1.5;
export const BURN_RELATIVE_FACTOR = 2;
/** A hard process timeout per call, so a build with no limit cannot hang leg C. */
export const BURN_GUARD_MS = 60_000;
/**
 * A busy loop on core 0. `timeout -s KILL` (coreutils) ends it on its own after 150 s, so a killed bun
 * cannot leave it spinning for good.
 */
export const burnerArgv = (taskset: string): string[] => [
  taskset,
  "-c",
  "0",
  "timeout",
  "-s",
  "KILL",
  "150",
  "sh",
  "-c",
  "while :; do :; done",
];

/** Probe First: its lines are what `per-test-coverage` checks (5 `if`, 6 `exit(1)`, 7 `exit(0)`). */
const FIRST_AL = `codeunit 50601 "Probe First"
{
    procedure First(X: Integer): Integer
    begin
        if X > 0 then
            exit(1);
        exit(0);
    end;
}
`;

const logicAl = (addBody = "exit(A + B);", broken = false) => `codeunit 50600 "Probe Logic"
{
    procedure Add(A: Integer; B: Integer): Integer
    begin
        ${addBody}
    end;

    procedure Spin(): Integer
    var
        I: Integer;
    begin
${broken ? "        NoSuchVar := 1;\n" : ""}        while true do
            I += 1;
        exit(I);
    end;

    procedure Burn(N: Integer): Integer
    var
        I: Integer;
        S: Integer;
    begin
        // A fixed amount of CPU work, no clock read: v3's AL clock is virtual (r6).
        for I := 1 to N do
            S := (S + I) mod 1000;
        exit(S);
    end;

    procedure ArmName(): Text
    begin
#if LETHALA
        exit('A');
#elif LETHALB
        exit('B');
#else
        exit('none');
#endif
    end;

    procedure InsertRow(K: Code[20]; V: Integer)
    var
        Row: Record "Probe Row";
    begin
        Row.Init();
        Row."Key" := K;
        Row.Value := V;
        Row.Insert();
    end;

    procedure RowCount(): Integer
    var
        Row: Record "Probe Row";
    begin
        exit(Row.Count());
    end;
}
`;

const ROW_AL = `table 50600 "Probe Row"
{
    fields
    {
        field(1; "Key"; Code[20]) { }
        field(2; Value; Integer) { }
    }
    keys
    {
        key(PK; "Key") { Clustered = true; }
    }
}
`;

/** The positive-control target of the Sleep rule (plan §6, `extras/ProbeSleeper.Codeunit.al`). */
const SLEEPER_AL = `codeunit 50605 "Probe Sleeper"
{
    procedure WaitThenDouble(X: Integer): Integer
    begin
        Sleep(600000);
        exit(X * 2);
    end;
}
`;

/** `timeout-is-cpu` (r14b): ONE burn that never finishes within any budget; both calls run it. */
const BURN_AL = `codeunit 50656 "Probe Burn Long"
{
    Subtype = Test;

    [Test]
    procedure CpuBurnLong()
    var
        Logic: Codeunit "Probe Logic";
    begin
        if Logic.Burn(${BURN_HUGE}) < 0 then
            Error('negative');
    end;
}
`;

const TESTS_AL = `codeunit 50650 "Probe Tests"
{
    Subtype = Test;

    var
        Logic: Codeunit "Probe Logic";
        Counter: Integer;

    [Test]
    procedure Passes()
    begin
        if Logic.Add(2, 3) <> 5 then
            Error('2+3 must be 5');
    end;

    [Test]
    procedure Fails()
    begin
        Error('boom %1', 5);
    end;

    [Test]
    procedure "Space Step"()
    begin
        if Logic.Add(1, 1) <> 2 then
            Error('1+1 must be 2');
    end;

    [Test]
    procedure PersistA()
    begin
        Logic.InsertRow('P1', 1);
        Counter += 1;
    end;

    [Test]
    procedure PersistB()
    begin
        Error('rows=%1 counter=%2', Logic.RowCount(), Counter);
    end;

    [Test]
    procedure ArmIs()
    begin
        Error('arm=%1', Logic.ArmName());
    end;

    [Test]
    procedure CoversOnlyA()
    var
        F: Codeunit "Probe First";
    begin
        if F.First(0) <> 0 then
            Error('First(0)');
    end;
}

codeunit 50651 "Probe Hang"
{
    Subtype = Test;

    [Test]
    procedure CpuHang()
    var
        Logic: Codeunit "Probe Logic";
    begin
        Logic.Spin();
    end;
}

codeunit 50652 "Probe Cut"
{
    Subtype = Test;

    var
        Logic: Codeunit "Probe Logic";
        Dirty: Boolean;

    [Test]
    procedure HangsDirty()
    begin
        Dirty := true;
        Logic.Spin();
        Dirty := false;
    end;

    [Test]
    procedure ChecksClean()
    begin
        if Dirty then
            Error('dirty');
    end;
}

codeunit 50653 "Probe Refusals"
{
    Subtype = Test;

    [Test]
    procedure HttpGet()
    var
        Client: HttpClient;
        Response: HttpResponseMessage;
    begin
        Client.Get('http://localhost:1/x', Response);
    end;

    [Test]
    procedure LaterFails()
    begin
        Error('later');
    end;
}

codeunit 50654 "Probe Refusals Public"
{
    Subtype = Test;

    [Test]
    procedure HttpGetPublic()
    var
        Client: HttpClient;
        Response: HttpResponseMessage;
    begin
        Client.Get('http://example.com/x', Response);
    end;

    [Test]
    procedure LaterFails()
    begin
        Error('later');
    end;
}

codeunit 50657 "Probe Commit"
{
    Subtype = Test;

    [Test]
    procedure CommitCall()
    begin
        Commit();
    end;
}

codeunit 50655 "Probe Keys"
{
    Subtype = Test;
    TestPermissions = Disabled;

    [Test]
    procedure DuplicateNamedKey()
    var
        Row: Record "Probe Row";
    begin
        Row.DeleteAll();
        Row.Init();
        Row."Key" := 'K1';
        Row.Insert();
        Row.Init();
        Row."Key" := 'K1';
        Row.Insert();
    end;
}
`;

/** Codeunit 50660 (plan r4 §8): NO CPU-bound test, which is load-bearing (#5611). Lines checked:
 *  `LongSleepA`'s Sleep is line 17. */
const SLEEP_TESTS_AL = `codeunit 50660 "Sleep Probe"
{
    Subtype = Test;

    var
        Sleeper: Codeunit "Probe Sleeper";

    [Test]
    procedure ShortSleep()
    begin
        Sleep(1500);
    end;

    [Test]
    procedure LongSleepA()
    begin
        Sleep(600000);
    end;

    [Test]
    procedure LongSleepB()
    begin
        Sleep(600000);
    end;

    [Test]
    procedure LongSleepThenAssert()
    var
        Started: DateTime;
        Elapsed: Duration;
    begin
        Started := CurrentDateTime();
        Sleep(600000);
        Elapsed := CurrentDateTime() - Started;
        if Elapsed < 600000 then
            Error('after sleep %1', Elapsed);
    end;

    [Test]
    procedure SleeperDoubles()
    begin
        if Sleeper.WaitThenDouble(21) <> 42 then
            Error('WaitThenDouble(21) must be 42');
    end;
}
`;

/**
 * R612 `serve-keep-reasons` (plan r3 §2): one test per entry of `V3_SERVE_SAFE_REFUSALS`, run in
 * ONE `serve` request. Its own tests folder, so these tests never reach the one-shot facts. The
 * OnRun overflows at once (row 6's text, without its 53 s loop, R638). Every test here must
 * COMPILE: since #5602's fix v3 runs nothing in a request whose apps do not compile, so one bad
 * test blinds the fact for all (R705).
 */
/** test hook (R705) */
export const SERVE_TESTS_AL = `codeunit 50670 "Serve Http"
{
    Subtype = Test;

    [Test]
    procedure HttpGet()
    var
        Client: HttpClient;
        Response: HttpResponseMessage;
    begin
        Client.Get('http://localhost:1/x', Response);
    end;
}

codeunit 50671 "Serve Commit"
{
    Subtype = Test;

    [Test]
    procedure CommitCall()
    begin
        Commit();
    end;
}

codeunit 50672 "Serve Cascade"
{
    Subtype = Test;

    [Test]
    procedure HttpGet()
    var
        Client: HttpClient;
        Response: HttpResponseMessage;
    begin
        Client.Get('http://localhost:1/x', Response);
    end;

    [Test]
    procedure LaterFails()
    begin
        Error('later');
    end;
}

codeunit 50673 "Serve OnRun"
{
    Subtype = Test;

    trigger OnRun()
    var
        I: Integer;
    begin
        I := 2147483647;
        I += 1;
    end;

    [Test]
    procedure Never()
    begin
    end;
}
`;

/** R667: one `Assert.AreEqual` failure, in its own tests app (only it depends on Library Assert). */
const ASSERT_TESTS_AL = `codeunit 50661 "Probe Assert"
{
    Subtype = Test;

    var
        Assert: Codeunit "Library Assert";

    [Test]
    procedure AssertAreEqual()
    begin
        Assert.AreEqual(1, 2, 'R667 values differ');
    end;
}
`;

/** Microsoft's Library Assert, as R657's probe declared it. */
const LIBRARY_ASSERT_DEP = {
  id: "dd0be2ea-f733-4d65-bb34-a28f4624fb14",
  name: "Library Assert",
  publisher: "Microsoft",
  version: "28.0.0.0",
};

/** R590: a dependency no package holds (an invented id), so v3 must say it skipped it. */
const ABSENT_DEP = {
  id: "7a1c0e52-5b8e-4d3a-9f60-2c7b8e1d2590",
  name: "LethAL R590 Absent",
  publisher: "LethAL",
  version: "1.0.0.0",
};

/** R590: one passing test, so v3 loads the project (an empty selection stops before dependencies). */
const DEP_SKIP_TESTS_AL = `codeunit 50662 "Probe DepSkip"
{
    Subtype = Test;

    [Test]
    procedure Runs()
    begin
    end;
}
`;

/** R667: a plain failed row's message, or `undefined` when the row is not a plain `fail`. */
const plainFailMessage = (
  r: { readonly status: string; readonly notRun?: boolean; readonly message?: string } | undefined,
): string | undefined =>
  r !== undefined && r.status === "fail" && r.notRun !== true ? r.message : undefined;

/**
 * R612: each `V3_SERVE_SAFE_REFUSALS` entry and the serve row that must match it. R705: the third
 * element says a plain trusted fail is also accepted (a #5602-fixed build moved http and cascade
 * one-shot; commit and onrun-failed are still refusals there).
 */
const SERVE_CASES: ReadonlyArray<readonly [string, string, boolean]> = [
  ["http", "Codeunit50670.HttpGet", true],
  ["commit", "Codeunit50671.CommitCall", false],
  ["cascade", "Codeunit50672.LaterFails", true],
  ["onrun-failed", "Codeunit50673.Never", false],
];

/** R612: the stop the update gate's serve daemon runs with (leg C's `timeout-classified` N). */
const SERVE_TEST_TIMEOUT_S = 3;
const SERVE_DEADLINE_MS = 120_000;

/** R612: `serve-keep-reasons`, a WARN fact: a moved reason only makes the daemon close. */
async function serveKeepReasons(env: V3ProbeEnv, app: string, root: string): Promise<V3Fact> {
  const tests = join(root, "serve-tests");
  await mkdir(join(tests, "src"), { recursive: true });
  await writeFile(
    join(tests, "app.json"),
    baseAppJson({
      id: TESTS_ID,
      name: "LethAL R612 Serve Probe Tests",
      idFrom: 50650,
      idTo: 50699,
      dependencies: [{ id: TARGET_ID, name: TARGET_NAME, publisher: "LethAL", version: "1.0.0.0" }],
    }),
  );
  await writeFile(join(tests, "src", "Serve.Codeunit.al"), SERVE_TESTS_AL);
  const cache = env.cacheDir !== undefined ? { ALRUNNER_CACHE: resolve(env.cacheDir) } : undefined;
  // R645: in the probe's scratch dir, so v3's coverage file never lands in the caller's.
  const spawn: ServerSpawnFn = (argv) =>
    (env.serveSpawn ?? defaultServerSpawn)(argv, {
      cwd: root,
      ...(cache !== undefined ? { env: cache } : {}),
    });
  const server = new AlRunnerServer(absToolPath(env.alRunnerPath), spawn, [], "serve");
  const expected = `one serve daemon (--test-timeout ${SERVE_TEST_TIMEOUT_S}, testIsolation test): four codeunits (five tests), each row notRun, error, and its V3_SERVE_SAFE_REFUSALS entry (${SERVE_CASES.map(([e]) => e).join(", ")}); http and cascade also accepted as a plain trusted fail (R705)`;
  let rows: readonly ServerTestLine[];
  try {
    await server.start(SERVE_DEADLINE_MS, [], SERVE_TEST_TIMEOUT_S);
    rows = (
      await server.runTests({ sourcePaths: [app, tests], testIsolation: "test" }, SERVE_DEADLINE_MS)
    ).tests;
  } catch (err) {
    return fact("serve-keep-reasons", "warn", "unmeasurable", expected, String(err));
  } finally {
    await server.close();
  }
  const moved: string[] = [];
  const how: string[] = [];
  for (const [entry, name, plainFailOk] of SERVE_CASES) {
    const r = rows.find((t) => t.name === name);
    const refusal =
      r !== undefined &&
      r.notRun === true &&
      r.status === "error" &&
      r.message !== undefined &&
      V3_SERVE_SAFE_REFUSALS[entry]?.test(r.message) === true;
    // R705: never a negated optional-chain form (r?.x !== ...): no row would read as fine.
    const pm = plainFailOk ? plainFailMessage(r) : undefined;
    const plainFail =
      pm !== undefined && !isV3RefusalText(pm) && (entry !== "cascade" || pm === "later");
    if (refusal || plainFail) {
      how.push(`${entry}: ${refusal ? "refusal" : "plain fail"}`);
    } else {
      moved.push(
        `${entry}: MOVED ${r === undefined ? `no row ${name}` : `${r.status} notRun=${String(r.notRun)} ${r.message ?? ""}`}`,
      );
    }
  }
  return fact(
    "serve-keep-reasons",
    "warn",
    moved.length === 0 ? "matches" : "diverged",
    expected,
    moved.length === 0
      ? `the keep rule accepts every row of all ${SERVE_CASES.length} entries (${how.join(", ")})`
      : moved.join("; "),
  );
}

export interface V3ProbeEnv {
  readonly alRunnerPath: string;
  /** `.gated`'s version (or the candidate's own `--version` in the update gate). */
  readonly expectedVersion: string;
  readonly packagesDir: string;
  readonly bcVersion: string;
  readonly alcPath?: string;
  readonly cacheDir?: string;
  readonly spawn?: SpawnFn;
  readonly alcIo?: ArtifactIo;
  /** `taskset` for `timeout-is-cpu`; absent: that fact is unmeasurable. */
  readonly tasksetPath?: string;
  /**
   * Test hook: starts ONE of the competing busy loops on core 0; `timeout-is-cpu` calls it
   * `BURN_BUSY_LOOPS` times (default: `burnerArgv`, `taskset -c 0 timeout -s KILL 150 sh -c ...`).
   */
  readonly startBurner?: () => { kill(): void };
  /** Test hook: `timeout-is-cpu`'s per-call hard process timeout (default 60 s). */
  readonly burnGuardMs?: number;
  /**
   * M1 (review build Opus): `timeout-is-cpu` pins burns to one core beside busy loops and takes about
   * 20 s (R693, r14b), so the fact is GATE-ONLY: the update gate's leg C measures it (this field absent), and
   * its pass is recorded with `.gated`. A session names that record here instead: the burns do not
   * run, and the fact cannot refuse a session on other hardware.
   */
  readonly gateOnlyTrusted?: string;
  /** R612 test hook: the `serve` daemon for `serve-keep-reasons` (default: the real binary). */
  readonly serveSpawn?: ServerSpawnFn;
  /** R612 M-2: `.gated`'s warn-fact readings (what the gate's leg C read), shown by a session. */
  readonly gatedWarnFacts?: Readonly<Record<string, string>>;
  /**
   * R667: Microsoft's Library Assert `.app`, passed as `--dep` to the `Assert.AreEqual` half of
   * `message-has-no-type-prefix`. Leg C only: a session's packages need not hold it, so a session
   * (`gateOnlyTrusted`) reads the plain `Error()` half alone.
   */
  readonly libraryAssertApp?: string;
}

interface Call {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly wallMs: number;
  /** The call's `guardMs` timeout fired (the process was killed by it). */
  readonly timedOut: boolean;
  readonly rows: readonly V3Row[] | undefined;
  readonly coverage: unknown;
}

async function writeProject(
  root: string,
  logic: string,
  testsDir = "tests",
): Promise<{ app: string; tests: string }> {
  const app = join(root, "app");
  const tests = join(root, testsDir);
  await mkdir(join(app, "src"), { recursive: true });
  await mkdir(join(tests, "src"), { recursive: true });
  await writeFile(
    join(app, "app.json"),
    baseAppJson({ id: TARGET_ID, name: TARGET_NAME, idFrom: 50600, idTo: 50649 }),
  );
  await writeFile(join(app, "src", "Logic.Codeunit.al"), logic);
  await writeFile(join(app, "src", "First.Codeunit.al"), FIRST_AL);
  await writeFile(join(app, "src", "Row.Table.al"), ROW_AL);
  await writeFile(join(app, "src", "Sleeper.Codeunit.al"), SLEEPER_AL);
  await writeFile(
    join(tests, "app.json"),
    baseAppJson({
      id: TESTS_ID,
      name: "LethAL R586 Contract Tests",
      idFrom: 50650,
      idTo: 50699,
      dependencies: [{ id: TARGET_ID, name: TARGET_NAME, publisher: "LethAL", version: "1.0.0.0" }],
    }),
  );
  await writeFile(join(tests, "src", "Tests.Codeunit.al"), TESTS_AL);
  await writeFile(join(tests, "src", "SleepProbe.Codeunit.al"), SLEEP_TESTS_AL);
  await writeFile(join(tests, "src", "Burn.Codeunit.al"), BURN_AL);
  return { app, tests };
}

const fact = (
  name: string,
  kind: V3Fact["kind"],
  verdict: V3Fact["verdict"],
  expected: string,
  measured: string,
  // R639 F4: `measured` is kept whole; only the summary lines that quote it are cut.
): V3Fact => ({ fact: name, kind, verdict, expected, measured });

const rowOf = (c: Call | undefined, method: string): V3Row | undefined =>
  c?.rows?.find((r) => r.method === method);

/** r9: a decided row is the ONLY row of its method in its call; otherwise `undefined`. */
const onlyRow = (c: Call, method: string): V3Row | undefined => {
  const rs = c.rows?.filter((r) => r.method === method) ?? [];
  return rs.length === 1 ? rs[0] : undefined;
};

/** r9: how many rows of `method` the call gave (0 when it gave no document). */
const rowCount = (c: Call, method: string): number =>
  c.rows?.filter((r) => r.method === method).length ?? 0;

/** F4: a row fact's measured text, the rows first. */
const rowsText = (c: Call, method: string): string =>
  `${JSON.stringify(c.rows?.filter((r) => r.method === method) ?? null)} exit ${c.exitCode}`;

/** The probe. Never throws for a v3 answer; a fact it could not read is `unmeasurable`. */
export async function runV3ContractProbe(env: V3ProbeEnv): Promise<V3ContractResult> {
  const root = await mkdtemp(join(tmpdir(), "lethal-r586-contract-"));
  // R645: every v3 process the probe starts runs in `root` (v3 writes coverage.cobertura.xml into
  // its cwd). Paths handed to v3 are made absolute below.
  const spawnIn = env.spawn ?? defaultSpawn;
  const spawn: SpawnFn = (argv, opts) => spawnIn(argv, { ...opts, cwd: root });
  const alRunnerPath = absToolPath(env.alRunnerPath);
  const packagesDir = resolve(env.packagesDir);
  const cacheDir = env.cacheDir !== undefined ? resolve(env.cacheDir) : undefined;
  const facts: V3Fact[] = [];
  try {
    const { app, tests } = await writeProject(root, logicAl());
    let seq = 0;
    const call = async (
      args: readonly string[],
      o: {
        coverage?: boolean;
        app?: string;
        tests?: string;
        wrap?: readonly string[];
        codeunit?: number;
        /** A hard process timeout: the call is killed after this long (`timedOut`). */
        guardMs?: number;
      } = {},
    ): Promise<Call> => {
      seq += 1;
      const cov = join(root, `cov-${seq}.json`);
      const argv = [
        ...(o.wrap ?? []),
        alRunnerPath,
        "test",
        "--output-json",
        "--isolation",
        "test",
        "--package-cache",
        packagesDir,
        "--bc-version",
        env.bcVersion,
        "--no-download",
        ...args,
        ...(o.coverage === true ? ["--coverage-json", cov] : []),
        o.app ?? app,
        o.tests ?? tests,
      ];
      const t0 = Date.now();
      const signal = o.guardMs !== undefined ? AbortSignal.timeout(o.guardMs) : undefined;
      const res = await spawn(argv, {
        ...(cacheDir !== undefined ? { env: { ALRUNNER_CACHE: cacheDir } } : {}),
        ...(signal !== undefined ? { signal } : {}),
      }).catch((e: unknown) => ({ exitCode: -1, stdout: "", stderr: String(e) }));
      const wallMs = Date.now() - t0;
      const decoded = o.codeunit !== undefined ? decodeV3Rows(res.stdout, o.codeunit) : undefined;
      let coverage: unknown;
      if (o.coverage === true) {
        try {
          coverage = JSON.parse(await readFile(cov, "utf8"));
        } catch {
          coverage = undefined;
        }
      }
      return {
        ...res,
        wallMs,
        timedOut: signal?.aborted === true,
        rows: decoded !== undefined && "rows" in decoded ? decoded.rows : undefined,
        coverage,
      };
    };

    // version
    const v = await spawn([alRunnerPath, "--version"]).catch(() => ({
      exitCode: -1,
      stdout: "",
      stderr: "",
    }));
    const version = v.stdout.trim();
    facts.push(
      fact(
        "version",
        "contract",
        version === env.expectedVersion ? "matches" : "diverged",
        env.expectedVersion,
        version,
      ),
    );

    // unknown-flag-rejected
    const bad = await spawn([
      alRunnerPath,
      "test",
      "--lethal-wire-contract-probe",
      app,
      tests,
    ]).catch(() => ({
      exitCode: -1,
      stdout: "",
      stderr: "",
    }));
    facts.push(
      fact(
        "unknown-flag-rejected",
        "contract",
        bad.exitCode === 2 && bad.stdout.trim() === "" ? "matches" : "diverged",
        "exit 2, no document",
        `exit ${bad.exitCode}, stdout ${bad.stdout.trim() === "" ? "empty" : "non-empty"}`,
      ),
    );

    // The main codeunit, with coverage and --verbose (bc-build-pinned reads its stderr).
    const main = await call(["--verbose", "--codeunit", "50650"], {
      coverage: true,
      codeunit: 50650,
    });
    const shapeOk =
      main.rows !== undefined &&
      main.rows.length === 7 &&
      main.rows.every((r) => typeof r.durationMs === "number");
    facts.push(
      fact(
        "rows-shape",
        "contract",
        shapeOk ? "matches" : main.rows === undefined ? "unmeasurable" : "diverged",
        "7 rows of codeunit 50650 with name, codeunit, method, status, durationMs (and notRun, message)",
        main.rows === undefined
          ? `exit ${main.exitCode}, no decodable document`
          : `${main.rows.length} rows`,
      ),
    );
    facts.push(
      fact(
        "quoted-name-in-rows",
        "contract",
        rowOf(main, "Space Step")?.status === "pass" ? "matches" : "diverged",
        'a row with method "Space Step", pass',
        JSON.stringify(rowOf(main, "Space Step") ?? null),
      ),
    );
    const target = /target: BC ([0-9.]+)/.exec(main.stderr)?.[1];
    facts.push(
      fact(
        "bc-build-pinned",
        "contract",
        target === undefined ? "unmeasurable" : target === env.bcVersion ? "matches" : "diverged",
        `--verbose "target: BC ${env.bcVersion}"`,
        target ?? "no target line",
      ),
    );
    const armNone = rowOf(main, "ArmIs")?.message;
    const defA = await call(["--define", "LETHALA", "--codeunit", "50650"], { codeunit: 50650 });
    const armA = rowOf(defA, "ArmIs")?.message;
    facts.push(
      fact(
        "define-honoured",
        "contract",
        armNone === "arm=none" && armA === "arm=A" ? "matches" : "diverged",
        "arm=none without --define, arm=A with --define LETHALA",
        `${armNone ?? "?"} / ${armA ?? "?"}`,
      ),
    );
    // per-test-coverage: CoversOnlyA reaches Probe First lines 5 and 7, never line 6.
    const ptc = (
      main.coverage as
        | {
            perTestCoverage?: {
              test: string;
              coverage: { file: string; statements: { line: number; hits: number }[] }[];
            }[];
          }
        | undefined
    )?.perTestCoverage;
    const onlyA = ptc
      ?.find((e) => e.test === "Codeunit50650.CoversOnlyA")
      ?.coverage.filter((f) => f.file.endsWith("First.Codeunit.al"))
      .flatMap((f) => f.statements.filter((s) => s.hits > 0).map((s) => s.line))
      .sort((a, b) => a - b);
    facts.push(
      fact(
        "per-test-coverage",
        "contract",
        onlyA === undefined
          ? "unmeasurable"
          : JSON.stringify(onlyA) === "[5,7]"
            ? "matches"
            : "diverged",
        "CoversOnlyA hits Probe First lines 5 and 7 only",
        JSON.stringify(onlyA ?? null),
      ),
    );
    // codeunit-runs-whole (#5611): PersistB sees PersistA's codeunit variable.
    const persistB = rowOf(main, "PersistB")?.message;
    facts.push(
      fact(
        "codeunit-runs-whole",
        "defect",
        persistB === undefined
          ? "unmeasurable"
          : persistB === "rows=0 counter=1"
            ? "defect-present"
            : "gone",
        'PersistB "rows=0 counter=1" (database rolled back, the codeunit variable kept)',
        persistB ?? "no row",
      ),
    );
    // codeunit-row-equals-exact-row
    const exact = await call(["--test-exact", "Codeunit50650.PersistB"], { codeunit: 50650 });
    const e = rowOf(exact, "PersistB");
    facts.push(
      fact(
        "codeunit-row-equals-exact-row",
        "contract",
        e !== undefined && e.status === rowOf(main, "PersistB")?.status && e.message === persistB
          ? "matches"
          : "diverged",
        "the PersistB row from --test-exact equals the --codeunit row",
        JSON.stringify(e ?? null),
      ),
    );
    // none-selected-exit (#5613), a DEFECT fact since pre-commitment r7: upstream #5622 fixed it, and
    // a fix LethAL asked for must read `gone` (held), never `diverged` (gate-fail).
    const none = await call(["--codeunit", "0"], { codeunit: 0 });
    facts.push(
      fact(
        "none-selected-exit",
        "defect",
        none.exitCode !== 6
          ? "diverged"
          : none.stdout.trim() === ""
            ? "defect-present"
            : none.rows?.length === 0
              ? "gone"
              : "diverged",
        "--codeunit 0: exit 6, no document (#5613; its fix: exit 6, a document with 0 rows)",
        `exit ${none.exitCode}, stdout ${none.stdout.trim() === "" ? "empty" : `${none.rows === undefined ? "not a v3 document" : `${none.rows.length} rows`}`}`,
      ),
    );
    // quoted-name-unselectable (#5572)
    const quoted = await call(["--test-exact", "Codeunit50650.Space Step"]);
    facts.push(
      fact(
        "quoted-name-unselectable",
        "defect",
        quoted.exitCode === 6 ? "defect-present" : quoted.exitCode === 0 ? "gone" : "unmeasurable",
        '--test-exact "Codeunit50650.Space Step" exits 6',
        `exit ${quoted.exitCode}`,
      ),
    );
    // timeout-classified
    const hang = await call(["--test-timeout-secs", "3", "--codeunit", "50651"], {
      codeunit: 50651,
    });
    const h = rowOf(hang, "CpuHang");
    facts.push(
      fact(
        "timeout-classified",
        "contract",
        hang.exitCode === 7 && h?.notRun === true && h.message === "Test exceeded 3s timeout."
          ? "matches"
          : "diverged",
        'CpuHang at N=3: exit 7, notRun, "Test exceeded 3s timeout."',
        `exit ${hang.exitCode} ${JSON.stringify(h ?? null)} wall ${hang.wallMs} ms`,
      ),
    );
    // dependent-fail-after-timeout-is-notrun (pre-commitment r8, R637): v3, not LethAL, keeps a
    // failure caused by a stopped sibling's state from scoring as a kill. Pin its not-trusted row.
    const cut = await call(["--test-timeout-secs", "3", "--codeunit", "50652"], {
      codeunit: 50652,
    });
    const hd = rowOf(cut, "HangsDirty");
    const cc = rowOf(cut, "ChecksClean");
    facts.push(
      fact(
        "dependent-fail-after-timeout-is-notrun",
        "contract",
        cut.exitCode === 7 &&
          // Review M3: exactly these two rows, so a duplicate row cannot hide behind `rowOf`.
          cut.rows?.length === 2 &&
          hd?.notRun === true &&
          hd.message === "Test exceeded 3s timeout." &&
          cc?.notRun === true &&
          cc.status === "error" &&
          (cc.message ?? "").startsWith(
            "NotRun: out-of-scope: an earlier test of this codeunit was refused while it ran (HangsDirty: ",
          ) &&
          (cc.message ?? "").endsWith("this failure is not trusted: dirty")
          ? "matches"
          : "diverged",
        'N=3: exit 7, exactly 2 rows, HangsDirty notRun "Test exceeded 3s timeout.", ChecksClean notRun error "...refused while it ran (HangsDirty: ...this failure is not trusted: dirty"',
        // Review M2: HangsDirty first, so its divergence shows even when ChecksClean's text is long.
        `exit ${cut.exitCode}, ${cut.rows?.length ?? "no"} rows, HangsDirty=${JSON.stringify(hd === undefined ? null : { notRun: hd.notRun, message: hd.message })} ChecksClean=${JSON.stringify(cc === undefined ? null : { notRun: cc.notRun, status: cc.status, message: cc.message })}`,
      ),
    );
    // timeout-is-cpu (pre-commitment r14b, R693; fixed counts and r14's calibration both flipped):
    //   A: `--test-timeout-secs 2 --codeunit 50656` (`CpuBurnLong`, BURN_HUGE steps) under `taskset -c 0`,
    //      alone -> a notRun row "Test exceeded 2s timeout.";
    //   B: the same call beside 7 `taskset -c 0 sh -c 'while :; do :; done'` -> ALSO that row, with
    //      durationMs over 1.5 x the limit (3000 ms): a CPU-time stop is late in wall time, a wall-time
    //      stop comes at about 2000.
    // Each call has a 60 s process timeout. Killed: A -> diverged (no limit at all), B -> unmeasurable.
    // M1: GATE-ONLY. A session trusts the gated record.
    if (env.gateOnlyTrusted !== undefined) {
      facts.push(
        fact(
          "timeout-is-cpu",
          "contract",
          "matches",
          "gate-only (M1): measured by the update gate's leg C",
          `not re-measured in a session: trusted from ${env.gateOnlyTrusted}`,
        ),
      );
    } else if (env.tasksetPath === undefined) {
      facts.push(
        fact("timeout-is-cpu", "contract", "unmeasurable", "taskset available", "no taskset"),
      );
    } else if (env.startBurner === undefined && Bun.which("timeout") === null) {
      facts.push(
        fact(
          "timeout-is-cpu",
          "contract",
          "unmeasurable",
          "timeout (coreutils) available for the busy loops",
          "no timeout",
        ),
      );
    } else {
      const pin = [env.tasksetPath, "-c", "0"];
      const lateMs = BURN_LIMIT_SECS * 1000 * BURN_WALL_FACTOR;
      const expected = `at N=${BURN_LIMIT_SECS}: a huge burn on core 0 alone is a timeout row (A); the same burn beside ${BURN_BUSY_LOOPS} busy loops on core 0 is ALSO a timeout row, with durationMs over ${lateMs} AND over ${BURN_RELATIVE_FACTOR}x A's (B: a CPU-time stop is late in wall time; a wall-time limit stops both at the same time)`;
      const guardMs = env.burnGuardMs ?? BURN_GUARD_MS;
      const burnArgs = ["--test-timeout-secs", String(BURN_LIMIT_SECS), "--codeunit", "50656"];
      const stopped = (r: V3Row | undefined) =>
        r?.notRun === true && r.message === `Test exceeded ${BURN_LIMIT_SECS}s timeout.`;
      const callText = (c: Call, r: V3Row | undefined) =>
        `${JSON.stringify(r ?? null)} (wall ${c.wallMs} ms${c.timedOut ? `, killed by the ${guardMs} ms process timeout` : ""})`;
      // A: pinned, alone.
      const alone = await call(burnArgs, { codeunit: 50656, wrap: pin, guardMs });
      const a = rowOf(alone, "CpuBurnLong");
      let verdict: V3Fact["verdict"];
      let measured = `A ${callText(alone, a)}`;
      if (alone.timedOut) {
        // No limit at all: a build that never stops the burn.
        verdict = "diverged";
      } else if (a === undefined) {
        verdict = "unmeasurable";
      } else if (!stopped(a)) {
        verdict = "diverged";
      } else {
        // B: the same burn beside busy loops, started before and killed after (in a finally).
        const burners: { kill(): void }[] = [];
        let shared: Call;
        try {
          for (let i = 0; i < BURN_BUSY_LOOPS; i++)
            burners.push(
              env.startBurner?.() ??
                Bun.spawn(burnerArgv(env.tasksetPath), {
                  stdout: "ignore",
                  stderr: "ignore",
                }),
            );
          shared = await call(burnArgs, { codeunit: 50656, wrap: pin, guardMs });
        } finally {
          for (const b of burners) b.kill();
        }
        const s = rowOf(shared, "CpuBurnLong");
        measured += `; B ${callText(shared, s)}`;
        // Killed by the process timeout: B could not be read (A is the fact that shows a missing limit).
        // A row that is not a timeout row, or a stop at about the limit in wall time, breaks the contract.
        verdict =
          shared.timedOut || s === undefined
            ? "unmeasurable"
            : !stopped(s) ||
                (s.durationMs ?? 0) <= lateMs ||
                (s.durationMs ?? 0) <= BURN_RELATIVE_FACTOR * (a.durationMs ?? 0)
              ? "diverged"
              : "matches";
      }
      facts.push(fact("timeout-is-cpu", "contract", verdict, expected, measured));
    }
    // refusal-row-shape (#5608), a DEFECT fact since r9 (R639): HttpGet to localhost on 50653.
    const ref = await call(["--codeunit", "50653"], { codeunit: 50653 });
    facts.push(
      fact(
        "refusal-row-shape",
        "defect",
        refusalRowShape(ref),
        `HttpGet: a refusal row with the implied exit (#5608 present); its fix as BC's test runner hub (R706, owner ruling): fail, notRun false, "${BC_HTTP_HUB_TEXT}", exit 1`,
        rowsText(ref, "HttpGet"),
      ),
    );
    // refusal-row-shape-public and refusal-cascade (#5610), on 50654's own call (r9 §3, §4).
    const pub = await call(["--codeunit", "50654"], { codeunit: 50654 });
    const hp = onlyRow(pub, "HttpGetPublic");
    const pubRefused = isRefusalRow(hp);
    facts.push(
      fact(
        "refusal-row-shape-public",
        "contract",
        pub.rows !== undefined && pubRefused && pub.exitCode === impliedExit(pub.rows)
          ? "matches"
          : "diverged",
        "HttpGetPublic: a refusal row (notRun, error, NotRun: out-of-scope: ...), and the call's implied exit (7, or 1 when LaterFails is a plain fail)",
        rowsText(pub, "HttpGetPublic"),
      ),
    );
    const later = onlyRow(pub, "LaterFails");
    facts.push(
      fact(
        "refusal-cascade",
        "defect",
        !pubRefused || rowCount(pub, "LaterFails") === 0
          ? "unmeasurable"
          : later?.notRun === true
            ? "defect-present"
            : later?.status === "fail" && later.message === "later"
              ? "gone"
              : "diverged",
        "LaterFails (an Error after a refused HttpGetPublic) is notRun",
        rowsText(pub, "LaterFails"),
      ),
    );
    // commit-under-test-isolation (#5607): r9 §5, a refusal dressed as a fail is never `gone`.
    const commit = await call(["--codeunit", "50657"], { codeunit: 50657 });
    const c = onlyRow(commit, "CommitCall");
    facts.push(
      fact(
        "commit-under-test-isolation",
        "defect",
        rowCount(commit, "CommitCall") === 0
          ? "unmeasurable"
          : c?.notRun === true
            ? "defect-present"
            : c !== undefined && !isV3RefusalText(c.message)
              ? "gone"
              : "diverged",
        "CommitCall under --isolation test is notRun",
        rowsText(commit, "CommitCall"),
      ),
    );
    // message-has-no-type-prefix (R667): R657 measured v3's failure `message` with no `<Type>: `
    // prefix, so v3 keeps bcdev's assertion-screen rule. A build that adds one (v2's shape) would
    // skew the screen (R553); read a plain Error() (Fails, on the main call) and an Assert.AreEqual.
    const plain = plainFailMessage(rowOf(main, "Fails"));
    let assertMsg: string | undefined;
    let assertMeasured: string;
    if (env.libraryAssertApp !== undefined) {
      const at = join(root, "assert-tests");
      await mkdir(join(at, "src"), { recursive: true });
      await writeFile(
        join(at, "app.json"),
        baseAppJson({
          id: TESTS_ID,
          name: "LethAL R667 Assert Probe Tests",
          idFrom: 50650,
          idTo: 50699,
          dependencies: [LIBRARY_ASSERT_DEP],
        }),
      );
      await writeFile(join(at, "src", "Assert.Codeunit.al"), ASSERT_TESTS_AL);
      const ac = await call(["--dep", env.libraryAssertApp, "--codeunit", "50661"], {
        tests: at,
        codeunit: 50661,
      });
      assertMsg = plainFailMessage(onlyRow(ac, "AssertAreEqual"));
      assertMeasured = rowsText(ac, "AssertAreEqual");
    } else {
      assertMeasured =
        env.gateOnlyTrusted !== undefined
          ? `Assert half not re-measured in a session (gate-only); leg C reads it only from r12 on, so a .gated recorded before r12 never read it (${env.gateOnlyTrusted})`
          : "no Library Assert app";
    }
    // A session without the app trusts the gate for the Assert half; leg C without it cannot read it.
    const msgs: [string | undefined, string][] =
      env.libraryAssertApp === undefined && env.gateOnlyTrusted !== undefined
        ? [[plain, PROBE_MESSAGE_START.Fails]]
        : [
            [plain, PROBE_MESSAGE_START.Fails],
            [assertMsg, PROBE_MESSAGE_START.AssertAreEqual],
          ];
    // R675 (review r1 nit A): `prefix` when the expected start comes later, `reworded` when absent.
    const seen = msgs
      .map(([m, start]) => {
        if (m === undefined || m.startsWith(start)) return undefined;
        const at = m.indexOf(start);
        return at > 0
          ? `prefix ${JSON.stringify(m.slice(0, at))}`
          : `reworded ${JSON.stringify(m.slice(0, 60))}`;
      })
      .find((p) => p !== undefined);
    facts.push(
      fact(
        MESSAGE_PREFIX_FACT,
        "contract",
        seen !== undefined
          ? "diverged"
          : msgs.every(([m]) => m !== undefined)
            ? "matches"
            : "unmeasurable",
        "Fails (a plain Error()) and AssertAreEqual are plain fails whose messages start exactly with `boom 5` and `Assert.AreEqual failed.` (any text before them is a prefix; R675)",
        // The reading first: a session's refusal names it in its `measured:` line (`v3ContractRefusals`).
        `${seen !== undefined ? `${seen}; ` : ""}Fails ${JSON.stringify(plain ?? null)}; ${assertMeasured}`,
      ),
    );
    // dependency-skip-line (R590, R-537): the backend refuses a session on v3's `dependency skipped:`
    // line, so a build that stops printing it (or prints it only with --verbose) must refuse here, or
    // a call into the left-out app by id would score a kill BC never gives. A tests app that declares
    // a dependency no package holds.
    const dt = join(root, "dep-skip-tests");
    await mkdir(join(dt, "src"), { recursive: true });
    await writeFile(
      join(dt, "app.json"),
      baseAppJson({
        id: TESTS_ID,
        name: "LethAL R590 Dependency Skip Probe Tests",
        idFrom: 50650,
        idTo: 50699,
        dependencies: [ABSENT_DEP],
      }),
    );
    await writeFile(join(dt, "src", "DepSkip.Codeunit.al"), DEP_SKIP_TESTS_AL);
    const ds = await call(["--codeunit", "50662"], { tests: dt, codeunit: 50662 });
    const skipLines = v3DependencySkipLines(ds.stderr).filter((l) =>
      l.startsWith("dependency skipped:"),
    );
    facts.push(
      fact(
        "dependency-skip-line",
        "contract",
        ds.exitCode === -1
          ? "unmeasurable"
          : skipLines.some((l) => l.includes(ABSENT_DEP.name))
            ? "matches"
            : "diverged",
        `stderr has a line starting "dependency skipped:" that names ${ABSENT_DEP.name}`,
        `exit ${ds.exitCode}; ${skipLines.length > 0 ? JSON.stringify(skipLines[0]) : `no such line; stderr ${JSON.stringify(ds.stderr.slice(-300))}`}`,
      ),
    );
    // serve-keep-reasons (R612): GATE-ONLY, like timeout-is-cpu. M-2: a gate passes whatever this
    // fact reads, so a session shows the gate's own reading from `.gated`, never a claimed matches.
    if (env.gateOnlyTrusted !== undefined) {
      const read = env.gatedWarnFacts?.["serve-keep-reasons"];
      const verdict: V3ContractVerdict =
        read === "matches" || read === "diverged" ? read : "unmeasurable";
      facts.push(
        fact(
          "serve-keep-reasons",
          "warn",
          verdict,
          "gate-only (R612): measured by the update gate's leg C",
          read === undefined
            ? `not re-measured in a session (gate-only); .gated records no reading (gated before R612) (${env.gateOnlyTrusted})`
            : `not re-measured in a session (gate-only); the gate read ${read} (${env.gateOnlyTrusted})`,
        ),
      );
    } else facts.push(await serveKeepReasons(env, app, root));
    // duplicate-key-insert-raises (#5603), r9 §6 (branch F): bc1 FAILS the test at its end.
    const keys = await call(["--codeunit", "50655"], { codeunit: 50655 });
    const k = onlyRow(keys, "DuplicateNamedKey");
    facts.push(
      fact(
        "duplicate-key-insert-raises",
        "defect",
        rowCount(keys, "DuplicateNamedKey") === 0
          ? "unmeasurable"
          : k?.status === "pass" && !k.notRun
            ? "defect-present"
            : k?.status === "fail" && !k.notRun && (k.message ?? "") === BC_END_OF_TEST_TEXT
              ? "gone"
              : isRefusalRow(k) && (k?.message ?? "").includes("duplicate-key Insert")
                ? "refused"
                : "diverged",
        `DuplicateNamedKey passes (#5603 present); its fix as BC (bc1): fail, "${BC_END_OF_TEST_TEXT}"`,
        rowsText(keys, "DuplicateNamedKey"),
      ),
    );
    // sleep-is-noop (#5605) and sleep-line-covered, on codeunit 50660 (no CPU-bound sibling).
    const sleepN = await call(["--test-timeout-secs", "3", "--codeunit", "50660"], {
      coverage: true,
      codeunit: 50660,
    });
    const sleepFree = await call(["--codeunit", "50660"], { codeunit: 50660 });
    const n1 = classifySleep(sleepN);
    const n2 = classifySleep(sleepFree);
    facts.push(
      fact(
        "sleep-is-noop",
        "defect",
        // Upstream's proposed #5605 fix stops a long Sleep only under a timeout flag, so the
        // N=3 call alone reading `gone` is the fix; the flag-free call may stay instant.
        n1 === "gone" || n2 === "gone"
          ? "gone"
          : n1 === n2
            ? n1
            : n1 === "unmeasurable" || n2 === "unmeasurable"
              ? "unmeasurable"
              : "diverged",
        "codeunit 50660 with N=3 and with no flag: call under 1 s, Sleep rows durationMs under 100, and LongSleepThenAssert PASSES (the AL clock advanced >= 600000 ms): a virtual clock",
        `N=3: ${sleepN.wallMs} ms ${JSON.stringify(sleepN.rows ?? null).slice(0, 250)}; no flag: ${sleepFree.wallMs} ms`,
      ),
    );
    const sc = sleepN.coverage as
      | {
          coverage?: { file: string; statements: { line: number; hits: number }[] }[];
          perTestCoverage?: {
            test: string;
            coverage: { file: string; statements: { line: number; hits: number }[] }[];
          }[];
        }
      | undefined;
    const hits = (test: string, fileEnd: string, line: number): boolean =>
      sc?.perTestCoverage
        ?.find((t) => t.test === test)
        ?.coverage.some(
          (f) =>
            f.file.endsWith(fileEnd) && f.statements.some((s) => s.line === line && s.hits > 0),
        ) === true;
    const listed = (fileEnd: string, line: number): boolean =>
      sc?.coverage?.some(
        (f) => f.file.endsWith(fileEnd) && f.statements.some((s) => s.line === line),
      ) === true;
    const covered =
      hits("Codeunit50660.LongSleepA", "SleepProbe.Codeunit.al", 17) &&
      hits("Codeunit50660.SleeperDoubles", "Sleeper.Codeunit.al", 5) &&
      listed("SleepProbe.Codeunit.al", 17) &&
      listed("Sleeper.Codeunit.al", 5);
    facts.push(
      fact(
        "sleep-line-covered",
        "contract",
        sc === undefined ? "unmeasurable" : covered ? "matches" : "diverged",
        "LongSleepA hits SleepProbe line 17, SleeperDoubles hits Sleeper line 5, both listed top-level",
        sc === undefined
          ? "no coverage document"
          : covered
            ? "as expected"
            : "a hit or a listing is missing",
      ),
    );
    // predefined-symbols
    try {
      const p = await probeV3PredefinedSymbols({
        alRunnerPath: env.alRunnerPath,
        packagesDir: env.packagesDir,
        bcVersion: env.bcVersion,
        ...(env.cacheDir !== undefined ? { cacheDir: env.cacheDir } : {}),
        spawn,
      });
      facts.push(
        fact(
          "predefined-symbols",
          "contract",
          p.symbols.length === 0 ? "matches" : "diverged",
          "no arm active over CLEAN, CLEANSCHEMA, CLEANSCHEMA1..40, BC1..40",
          p.symbols.join(", ") || "none",
        ),
      );
    } catch (err) {
      facts.push(
        fact("predefined-symbols", "contract", "unmeasurable", "a complete mask", String(err)),
      );
    }
    // The alc facts: the compile proof catches what v3 runs anyway.
    if (env.alcPath === undefined) {
      for (const f of ["compile-failure-not-scorable", "positional-target-wins"]) {
        facts.push(fact(f, "contract", "unmeasurable", "alc available", "no alc"));
      }
      facts.push(
        fact("upstream-compile-errors", "defect", "unmeasurable", "alc available", "no alc"),
      );
    } else {
      const outDir = join(root, "alc-out");
      await mkdir(outDir, { recursive: true });
      const compiler = new ArtifactCompiler(
        { alcPath: env.alcPath, packageCachePath: env.packagesDir, outputDir: outDir },
        env.alcIo ?? defaultArtifactIo,
      );
      const broken = await writeProject(join(root, "broken"), logicAl("exit(A + B);", true));
      let alcRejected: string;
      try {
        await compiler.compileProject({
          projectDir: broken.app,
          packageCachePath: env.packagesDir,
          name: "broken",
        });
        alcRejected = "accepted";
      } catch (err) {
        alcRejected = err instanceof AlcCompileError ? "AlcCompileError" : `other: ${String(err)}`;
      }
      facts.push(
        fact(
          "compile-failure-not-scorable",
          "contract",
          alcRejected === "AlcCompileError" ? "matches" : "diverged",
          "alc rejects the broken target (AlcCompileError), so the backend never starts v3 on it",
          alcRejected,
        ),
      );
      const ranBroken = await call(["--codeunit", "50650"], {
        app: broken.app,
        tests: broken.tests,
        codeunit: 50650,
      });
      facts.push(
        fact(
          "upstream-compile-errors",
          "defect",
          ranBroken.rows === undefined
            ? "unmeasurable"
            : rowOf(ranBroken, "Passes")?.status === "pass"
              ? "defect-present"
              : "gone",
          "v3 runs the broken target and Passes passes (#5602)",
          `exit ${ranBroken.exitCode} ${JSON.stringify(rowOf(ranBroken, "Passes") ?? null)}`,
        ),
      );
      // positional-target-wins: a HIGHER-version target .app with source (Add + 100) in the test
      // app's .alpackages does not replace the positional target folder.
      const variant = await writeProject(join(root, "variant"), logicAl("exit(A + B + 100);"));
      const vManifest = JSON.parse(await readFile(join(variant.app, "app.json"), "utf8")) as Record<
        string,
        unknown
      >;
      await writeFile(
        join(variant.app, "app.json"),
        JSON.stringify({ ...vManifest, version: "9.0.0.0" }),
      );
      let positional: string;
      try {
        const out = await compiler.compileProject({
          projectDir: variant.app,
          packageCachePath: env.packagesDir,
          name: "variant",
        });
        const t2 = join(root, "tests-pinned");
        await cp(tests, t2, { recursive: true });
        await mkdir(join(t2, ".alpackages"), { recursive: true });
        await cp(out.appPath, join(t2, ".alpackages", "Variant_9.0.0.0.app"));
        const r = await call(["--codeunit", "50650"], { tests: t2, codeunit: 50650 });
        positional = rowOf(r, "Passes")?.status ?? `no row (exit ${r.exitCode})`;
      } catch (err) {
        positional = `unmeasurable: ${String(err)}`;
      }
      facts.push(
        fact(
          "positional-target-wins",
          "contract",
          positional.startsWith("unmeasurable")
            ? "unmeasurable"
            : positional === "pass"
              ? "matches"
              : "diverged",
          "Passes passes: the positional target, not the higher-version .app in .alpackages",
          positional,
        ),
      );
    }
    return { facts };
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

/** Who runs the session: `candidate` only for the update gate's own legs (`cfg.candidate`). */
export interface V3SessionKind {
  readonly candidate?: boolean;
  /**
   * R719: `<fact>=<verdict>` keys a per-build pin covers (`pinnedDefectCoverage`). Only the `gone`
   * and `refused` warnings read it; every other line, and every key not in it, still prints.
   */
  readonly muted?: ReadonlySet<string> | undefined;
}

/** The key `V3SessionKind.muted` holds for a fact as read. */
export const v3MuteKey = (f: { fact: string; verdict: string }): string => `${f.fact}=${f.verdict}`;

/**
 * r9 §2: `unlike-bc` refuses a NORMAL session by name (a test that reads `GetLastErrorText` or
 * catches the HTTP error would get another verdict than BC's); only the update gate's candidate
 * legs warn instead (`al-runner-v3-defect-unlike-bc`), so the gate measures every leg.
 */
const refusesUnlikeBc = (f: V3Fact, s: V3SessionKind): boolean =>
  f.kind === "defect" && f.verdict === "unlike-bc" && s.candidate !== true;

/** Every contract fact that is not `matches`; each refuses the session. */
export function v3ContractRefusals(r: V3ContractResult, s: V3SessionKind = {}): string[] {
  return (
    r.facts
      // A defect fact that reads neither present nor gone (r6: `diverged`) is not the defect we
      // pre-committed to, so it refuses like a contract fact.
      .filter(
        (f) =>
          (f.kind === "contract" && f.verdict !== "matches") ||
          (f.kind === "defect" && f.verdict === "diverged") ||
          refusesUnlikeBc(f, s),
      )
      .map(
        (f) =>
          `[lethal] al-runner-v3 contract ${f.verdict.toUpperCase()} — ${f.fact}\n    expected: ${f.expected}\n    measured: ${f.measured.slice(0, 600)}${f.fact === MESSAGE_PREFIX_FACT && f.verdict === "diverged" ? `\n    why: ${MESSAGE_PREFIX_REASON}` : ""}\n    Re-measure (plan §8) before changing code; the pinned build is in .gated (R586).`,
      )
  );
}

/** The `al-runner-v3-defect-gone` lines; they change nothing until a human re-measures. */
export function v3DefectsGone(r: V3ContractResult, muted?: ReadonlySet<string>): string[] {
  return r.facts
    .filter((f) => f.kind === "defect" && f.verdict === "gone" && !muted?.has(v3MuteKey(f)))
    .map(
      (f) =>
        `[lethal] al-runner-v3-defect-gone: ${f.fact}: re-measure before relying on it (measured ${f.measured.slice(0, 600)})`,
    );
}

/**
 * Every defect-fact warning a session prints (r6): the `gone` lines, the `refused` lines (r9), the
 * `unlike-bc` lines of a candidate session (r9), plus one `al-runner-v3-defect-unmeasurable` line
 * per defect fact that could not be measured. None refuses: §6 fails closed independently.
 */
export function v3DefectWarnings(r: V3ContractResult, s: V3SessionKind = {}): string[] {
  const defects = (v: string) => r.facts.filter((f) => f.kind === "defect" && f.verdict === v);
  return [
    ...v3DefectsGone(r, s.muted),
    // r9 §6: v3 declines a case BC fails; held in the gate, never gone, never a refusal.
    ...defects("refused")
      .filter((f) => !s.muted?.has(v3MuteKey(f)))
      .map(
        (f) =>
          `[lethal] al-runner-v3-defect-refused: ${f.fact}: v3 declines; not BC's reading (measured ${f.measured.slice(0, 600)})`,
      ),
    // r9 §2: only a candidate session gets here (a normal one is refused); every leg prints it.
    ...(s.candidate === true ? defects("unlike-bc") : []).map(
      (f) =>
        `[lethal] al-runner-v3-defect-unlike-bc: ${f.fact}: v3 fails as BC does, with another text (#5700); a normal session refuses this build (measured ${f.measured.slice(0, 600)})`,
    ),
    ...defects("unmeasurable").map(
      (f) =>
        `[lethal] al-runner-v3-defect-unmeasurable: ${f.fact}: not measured on this build; no capability depends on it (measured ${f.measured.slice(0, 600)})`,
    ),
  ];
}

/** One line per session: the contract its verdicts were produced under. */
export function v3ContractSummary(r: V3ContractResult): string {
  return `al-runner-v3 contract: ${r.facts.map((f) => `${f.fact}=${f.verdict}`).join(", ")}`;
}
