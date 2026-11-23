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
 * - `warn` (R612, plan r3 §2): `serve-keep-reasons`. Never refuses a session; a non-`matches` reading
 *   prints `al-runner-v3-serve-keep-reason-moved` (`V3_WARN_FACTS`), except `unkept` (R1000: a refusal
 *   no keep-list entry accepts), which fails the gate.
 * - `capability` (PR-114a): the eight `V3_CAPABILITY_FACTS` baseline batching rests on. `matches` /
 *   `diverged` / `unmeasurable`. Gate-fail in leg C when not `matches`; NEVER refuses a session (it only
 *   feeds `baselineBatchingFor`).
 */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { V3_TIMEOUT_MESSAGE, isV3RefusalText } from "./al-runner-rows";
import {
  AlRunnerServer,
  AlRunnerServerRequestError,
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
  v3MissingDependencyStop,
} from "./al-runner-v3-backend";
import { baseAppJson, probeV3PredefinedSymbols } from "./al-runner-v3-probe";
import { v3ChildEnv } from "./al-runner-v3-seed";
import { BC_HTTP_HUB_TEXT } from "./al-runner-v3-texts";
import { AlcCompileError, ArtifactCompiler, type ArtifactIo, defaultArtifactIo } from "./artifact";
import { monoNow } from "./clock";
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

/**
 * R1000: `serve-keep-reasons` only: a row refused with a text no keep-list entry accepts. Never refuses
 * a session (a warn fact); fails the update gate (`classifyLegC`).
 */
export type V3WarnVerdict = V3ContractVerdict | "unkept";

export interface V3Fact {
  readonly fact: string;
  /**
   * `warn` (R612): never refuses a session; fails the gate only on `unkept` (R1000), else only prints its line.
   * `capability` (PR-114a): never refuses a session (it only feeds `baselineBatchingFor`); a reading other
   * than `matches` fails the gate (`classifyLegC`).
   */
  readonly kind: "contract" | "defect" | "warn" | "capability";
  readonly verdict: V3ContractVerdict | V3DefectVerdict | V3WarnVerdict;
  readonly expected: string;
  readonly measured: string;
  /**
   * PR-117 (`capability` facts only): how the single (alone) request read, apart from the batch half.
   * `pass`: it was right (a `diverged` fact then means only batching is off); `fail`: the single
   * request itself is wrong; `none`: the alone reference ran and returned nothing. Absent: this fact has
   * no alone reference by design (or its writer did not pass in the batch), or it is not a capability fact.
   */
  readonly reference?: "pass" | "fail" | "none";
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
export const burnerArgv = (taskset: string, core = 0): string[] => [
  taskset,
  "-c",
  String(core),
  "timeout",
  "-s",
  "KILL",
  "150",
  "sh",
  "-c",
  "while :; do :; done",
];

/**
 * Addendum 1: the cores in `Cpus_allowed_list` of `/proc/self/status` text (ranges like `0-3,8,10-11`).
 * No such line or an unreadable list: `undefined`.
 */
export function parseAllowedCores(status: string | undefined): number[] | undefined {
  const m = /^Cpus_allowed_list:\s*(\S+)\s*$/m.exec(status ?? "");
  if (m === null) return undefined;
  const cores: number[] = [];
  for (const part of (m[1] ?? "").split(",")) {
    const r = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (r === null) return undefined;
    const lo = Number(r[1]);
    const hi = r[2] === undefined ? lo : Number(r[2]);
    if (hi < lo) return undefined;
    for (let c = lo; c <= hi; c++) cores.push(c);
  }
  return cores.length > 0 ? cores : undefined;
}

/** Addendum 1: a stopped A over the late line is contention only when its CPU is under this share of its wall. */
export const BURN_CPU_SHARE = 0.75;

/** R822: how many runs of A in all, so one busy moment does not cost a whole gate. */
export const BURN_TRIES = 3;

/**
 * R789: the least busy core from two `/proc/stat` snapshots (busy = total - idle - iowait, as a
 * delta). Ties go to the lowest core. Either snapshot unreadable or no `cpuN` line in both: core 0.
 */
export function leastBusyCore(
  before: string | undefined,
  after: string | undefined,
  /** Addendum 1: only these cores may be picked (the process's `Cpus_allowed_list`); absent: all. */
  allowed?: readonly number[],
): number {
  const busy = (text: string | undefined): Map<number, number> => {
    const m = new Map<number, number>();
    for (const line of (text ?? "").split("\n")) {
      const f = /^cpu(\d+)\s+(.*)$/.exec(line);
      if (f === null) continue;
      const n = (f[2] ?? "").trim().split(/\s+/).slice(0, 8).map(Number);
      if (n.length < 5 || n.some((x) => !Number.isFinite(x))) continue;
      const total = n.reduce((s, x) => s + x, 0);
      m.set(Number(f[1]), total - (n[3] ?? 0) - (n[4] ?? 0));
    }
    return m;
  };
  const b = busy(before);
  const a = busy(after);
  let best = 0;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const core of [...a.keys()].sort((x, y) => x - y)) {
    const prev = b.get(core);
    if (prev === undefined || (allowed !== undefined && !allowed.includes(core))) continue;
    const d = (a.get(core) ?? 0) - prev;
    if (d < bestDelta) {
      best = core;
      bestDelta = d;
    }
  }
  return best;
}

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

codeunit 50674 "Serve Http Public"
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
}

codeunit 50675 "Serve Cascade Seq"
{
    Subtype = Test;

    trigger OnRun()
    begin
        if not NumberSequence.Exists('R1000SEQ') then
            NumberSequence.Insert('R1000SEQ');
    end;

    [Test]
    procedure B_ChangesSeq()
    var
        N: BigInteger;
    begin
        N := NumberSequence.Next('R1000SEQ');
        N := NumberSequence.Next('R1000SEQ');
    end;

    [Test]
    procedure C_UsesSeq()
    var
        N: BigInteger;
    begin
        N := NumberSequence.Next('R1000SEQ');
    end;
}

codeunit 50676 "Serve Cascade Key"
{
    Subtype = Test;

    trigger OnRun()
    begin
        IsolatedStorage.Set('R1000KEY', 'v1', DataScope::Module);
    end;

    [Test]
    procedure B_ChangesKey()
    begin
        IsolatedStorage.Set('R1000KEY', 'v2', DataScope::Module);
    end;

    [Test]
    procedure C_UsesKey()
    var
        V: Text;
    begin
        IsolatedStorage.Get('R1000KEY', DataScope::Module, V);
    end;
}

codeunit 50677 "Serve RecRef FieldCount"
{
    Subtype = Test;

    [Test]
    procedure Refuses()
    var
        RecRef: RecordRef;
        N: Integer;
    begin
        N := RecRef.FieldCount();
    end;
}

codeunit 50678 "Serve RecRef FindSet"
{
    Subtype = Test;

    [Test]
    procedure Refuses()
    var
        RecRef: RecordRef;
    begin
        if RecRef.FindSet() then;
    end;
}

codeunit 50679 "Serve RecRef SetRecFilter"
{
    Subtype = Test;

    [Test]
    procedure Refuses()
    var
        RecRef: RecordRef;
    begin
        RecRef.SetRecFilter();
    end;
}

codeunit 50680 "Serve RecRef SetLoadFields"
{
    Subtype = Test;

    [Test]
    procedure Refuses()
    var
        RecRef: RecordRef;
    begin
        RecRef.SetLoadFields(1);
    end;
}

codeunit 50681 "Serve FieldRef Class"
{
    Subtype = Test;

    [Test]
    procedure Refuses()
    var
        FldRef: FieldRef;
        C: FieldClass;
    begin
        C := FldRef.Class();
    end;
}

codeunit 50682 "Serve GetTable Variant"
{
    Subtype = Test;

    [Test]
    procedure Refuses()
    var
        RecRef: RecordRef;
        V: Variant;
    begin
        RecRef.GetTable(V);
    end;
}

codeunit 50683 "Serve Bind Publisher"
{
    [IntegrationEvent(false, false)]
    procedure OnPing()
    begin
    end;
}

codeunit 50684 "Serve Bind Sub"
{
    EventSubscriberInstance = Manual;

    [EventSubscriber(ObjectType::Codeunit, Codeunit::"Serve Bind Publisher", 'OnPing', '', false, false)]
    local procedure HandlePing()
    begin
    end;
}

codeunit 50685 "Serve Bind Cascade"
{
    Subtype = Test;

    var
        Sub: Codeunit "Serve Bind Sub";
        Pub: Codeunit "Serve Bind Publisher";
        Fails: Boolean;

    [Test]
    procedure A_BindThenFail()
    begin
        Fails := true;
        BindSubscription(Sub);
        Pub.OnPing();
        if Fails then
            Error('planted');
        UnbindSubscription(Sub);
    end;

    [Test]
    procedure B_BindAgain()
    begin
        BindSubscription(Sub);
        Pub.OnPing();
        UnbindSubscription(Sub);
    end;
}

report 50686 "Serve Format Region"
{
    ProcessingOnly = true;
    UsageCategory = None;

    trigger OnPreReport()
    var
        D: Decimal;
        T: Text;
    begin
        CurrReport.FormatRegion := 'en-GB';
        D := 1234.5;
        T := Format(D, 0, 4);
        if T = '' then
            Error('empty');
    end;
}

codeunit 50687 "Serve Format Region Test"
{
    Subtype = Test;

    [Test]
    procedure Refuses()
    begin
        Report.Run(Report::"Serve Format Region", false, false);
    end;
}

page 50688 "Serve Caption Page"
{
    PageType = Card;
    UsageCategory = None;
    DataCaptionExpression = CaptionText();

    local procedure CaptionText(): Text
    begin
        exit('x');
    end;
}

codeunit 50689 "Serve Caption Test"
{
    Subtype = Test;

    [Test]
    procedure Refuses()
    var
        TP: TestPage "Serve Caption Page";
        C: Text;
    begin
        TP.OpenView();
        C := TP.Caption();
    end;
}

table 50690 "Serve Stale Row"
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

codeunit 50691 "Serve Stale Sub"
{
    [EventSubscriber(ObjectType::Table, Database::"Serve Stale Row", 'OnBeforeDeleteEvent', '', false, false)]
    local procedure OnBeforeDelete(var Rec: Record "Serve Stale Row"; RunTrigger: Boolean)
    begin
    end;
}

codeunit 50690 "Serve Stale Buffer"
{
    Subtype = Test;

    [Test]
    procedure Refuses()
    var
        R: Record "Serve Stale Row";
        Other: Record "Serve Stale Row";
        RRef: RecordRef;
    begin
        R."Key" := 'A';
        R.Insert(false);
        Other.Get('A');
        Other.Value := 5;
        Other.Modify();
        Commit();
        RRef.Open(Database::"Serve Stale Row");
        RRef.LockTable();
        R.Delete(false);
    end;
}

table 50692 "Serve Desc Doc"
{
    LookupPageId = "Serve Desc Docs";
    fields
    {
        field(1; "No."; Code[20]) { }
        field(3; Grp; Code[10]) { }
    }
    keys
    {
        key(PK; "No.") { Clustered = true; }
        key(ByGrp; Grp) { }
    }
}

page 50693 "Serve Desc Docs"
{
    PageType = List;
    SourceTable = "Serve Desc Doc";
    SourceTableView = sorting(Grp) order(descending);
    Editable = false;
    UsageCategory = None;
    layout
    {
        area(Content)
        {
            repeater(Rows)
            {
                field("No."; Rec."No.") { ApplicationArea = All; }
                field(Grp; Rec.Grp) { ApplicationArea = All; }
            }
        }
    }

    var
        Seen: Integer;

    trigger OnAfterGetRecord()
    begin
        Seen += 1;
    end;

    trigger OnAfterGetCurrRecord()
    begin
        Seen += 1;
    end;
}

codeunit 50694 "Serve GoToKey Desc"
{
    Subtype = Test;

    [Test]
    [HandlerFunctions('DocsHandler')]
    procedure Refuses()
    var
        Doc: Record "Serve Desc Doc";
        V: Variant;
        i: Integer;
    begin
        for i := 1 to 60 do begin
            Doc.Init();
            Doc."No." := 'D' + Format(1000 + i);
            Doc.Grp := 'G' + Format(1000 + i);
            Doc.Insert();
        end;
        Clear(Doc);
        V := Doc;
        Page.RunModal(0, V);
    end;

    [ModalPageHandler]
    procedure DocsHandler(var Docs: TestPage "Serve Desc Docs")
    begin
        Docs.GoToKey('D1030');
        Docs.OK().Invoke();
    end;
}

table 50695 "Serve Flag Row"
{
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; Flag; Boolean) { }
    }
    keys
    {
        key(PK; "No.") { Clustered = true; }
    }
}

codeunit 50696 "Serve Flag Words"
{
    Subtype = Test;

    [Test]
    procedure Refuses()
    var
        Row: Record "Serve Flag Row";
    begin
        GlobalLanguage(1030);
        Row.SetFilter(Flag, 'Ja');
    end;
}

table 50698 "Serve Blob Row"
{
    fields
    {
        field(1; "No."; Code[20]) { }
        field(2; Data; Blob) { }
    }
    keys
    {
        key(PK; "No.") { Clustered = true; }
    }
}

codeunit 50697 "Serve Download"
{
    Subtype = Test;

    [Test]
    procedure Refuses()
    var
        Row: Record "Serve Blob Row" temporary;
        InS: InStream;
        FileName: Text;
    begin
        Row.Data.CreateInStream(InS);
        FileName := 'a.txt';
        File.DownloadFromStream(InS, '', '', '', FileName);
    end;
}

// PR-54: the zip-archive-invalid-data family needs the .NET helper: not here (the update gate has no sidecar, R1017).
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
 * one-shot; commit and onrun-failed are still refusals there). R1000: the fourth says a plain pass
 * is accepted (a build that measures the case runs the test).
 */
export const SERVE_CASES: ReadonlyArray<readonly [string, string, boolean, boolean]> = [
  ["http", "Codeunit50670.HttpGet", true, false],
  ["commit", "Codeunit50671.CommitCall", false, false],
  ["cascade", "Codeunit50672.LaterFails", true, false],
  ["onrun-failed", "Codeunit50673.Never", false, false],
  // R808: a public host reaches the runtime's own refusal (localhost is a plain fail on alpha.7+),
  // so the `http` entry's current wording is exercised. No plain-fail fallback.
  ["http", "Codeunit50674.HttpGetPublic", false, false],
  // R1000 (coord R-989): the families added after R612, each a refusal a serve warm-up meets. Their
  // texts were never on the gate, so edge-847b1fa5a's reworded cascade passed it unseen.
  ["cascade-existing-state", "Codeunit50675.C_UsesSeq", false, true],
  ["cascade-existing-state", "Codeunit50676.C_UsesKey", false, true],
  // Not `company-findset`: this daemon runs with no package cache, so `Record Company` is "outside the
  // workspace" here (measured on the gate, R-989); its text is checked one-shot with packages instead
  // (`/coord/handoff/R-989/probe-cases/`, all 15 gated builds).
  // R998 (coord R-998): the three families kept for DO's mutant phase, each measured text once.
  // R1026: edge-5a58a0f16 runs the RecordRef and GetTable cases and fails them with BC's error, so
  // they also accept that plain fail (its text pinned in PLAIN_FAIL_TEXT); FieldRef.Class stays a refusal.
  ["recordref-not-open", "Codeunit50677.Refuses", true, false],
  ["recordref-not-open", "Codeunit50678.Refuses", true, false],
  ["recordref-not-open", "Codeunit50679.Refuses", true, false],
  ["recordref-not-open", "Codeunit50680.Refuses", true, false],
  ["fieldref-never-assigned", "Codeunit50681.Refuses", false, false],
  ["gettable-unassigned-variant", "Codeunit50682.Refuses", true, false],
  // R1019 (coord PR-14): Filter Tokens' cascade, measured once. A_BindThenFail is a plain trusted fail.
  ["cascade-manual-binding", "Codeunit50685.B_BindAgain", false, false],
  // PR-18 lever 1: DO's FormatRegion family, measured once (the zip family needs the .NET helper: not here).
  ["format-region-std4", "Codeunit50687.Refuses", false, false],
  // R1043: DO's caption family (t4: 63 of 87 daemons), measured once.
  ["caption-no-source-table", "Codeunit50689.Refuses", false, false],
  // R1009 (coord PR-29): the stale-buffer refusal, measured once on edge-5a58a0f16.
  ["stale-buffer-after-lock", "Codeunit50690.Refuses", false, false],
  // PR-47: DO t6's GoToKey refusal, measured once on edge-5a58a0f16 (`/coord/handoff/PR-47/`).
  ["gotokey-desc-last-row-above-window", "Codeunit50694.Refuses", false, false],
  // PR-53: DO t7's SetFilter-on-a-Boolean refusal, measured once on edge-5a58a0f16 (`/coord/handoff/PR-53/`).
  ["setfilter-boolean-language-words", "Codeunit50696.Refuses", false, false],
  // PR-54: DO's File.DownloadFromStream and ZipArchive-on-no-zip refusals, measured once on edge-5a58a0f16 (`/coord/handoff/PR-54/`).
  ["download-from-stream-needs-client", "Codeunit50697.Refuses", false, false],
  // PR-54: zip-archive-invalid-data has no case here (it needs the .NET helper); the serve-rule tests pin it.
];

/**
 * R705, R1026: the message a plain trusted fail of an entry must carry to be accepted, where the
 * case's own failure is known (cascade: its later test's `Error('later')`; R998's cases: the error
 * BC raises, as edge-5a58a0f16 words it). Another plain fail of such an entry is a move.
 */
const PLAIN_FAIL_TEXT: Readonly<Record<string, string>> = {
  cascade: "later",
  "recordref-not-open": "The record is not open.",
  "gettable-unassigned-variant":
    "Microsoft.Dynamics.Nav.Runtime.NavVariant variable not initialized.",
};

/**
 * R1000: a row the runtime REFUSED (notRun, error) with a text no `V3_SERVE_SAFE_REFUSALS` entry
 * accepts. On serve such a row closes the daemon, and at the warm-up it sends the whole run to
 * one-shot (R786): R-984's DO window scored 35 covered mutants in an hour. So this, unlike any other
 * move, fails the update gate (`unkept`, `classifyLegC`). Review: the same condition as the daemon
 * rule's, so a refused row with NO message is unkept too, and every row of the request is checked,
 * not only the judged ones (an unjudged refused row closes a real warm-up just the same).
 */
const unkeptRefusal = (r: ServerTestLine | undefined): boolean =>
  r !== undefined &&
  r.notRun === true &&
  r.status === "error" &&
  !(
    r.message !== undefined &&
    Object.values(V3_SERVE_SAFE_REFUSALS).some((re) => re.test(r.message ?? ""))
  );

/**
 * PR-363 (R1152): one generated app per refusal family (`scripts/pr363-legc-keep-apps.ts`); each holds only the
 * cells chosen for the keep entries that family can produce, and gets its own fresh daemon and request.
 */
export interface V3KeepApp {
  readonly family: string;
  /** The app folder (a `sourcePaths` entry). */
  readonly dir: string;
  /** The entry each test must be refused under, and the serve test name (`Codeunit<id>.<method>`). */
  readonly cases: readonly { readonly entry: string; readonly name: string }[];
}

/** PR-363: how many family apps the generator pins; fewer in `V3ProbeEnv.keepApps` reads `unmeasurable`. */
export const V3_KEEP_APP_FAMILIES = 10;
/** PR-363 (build review L1): how many cases the family apps pin in all; a manifest with another count is `unmeasurable`. */
export const V3_KEEP_CASES = 47;

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
      env: v3ChildEnv(cache),
    });
  const server = new AlRunnerServer(absToolPath(env.alRunnerPath), spawn, [], "serve");
  const pinned = env.serveKeepMoved === true;
  const expected = `one serve daemon (--test-timeout ${SERVE_TEST_TIMEOUT_S}, testIsolation test): twenty-three codeunits, a report, two pages and four tables (twenty-four tests), each judged row notRun, error, and its V3_SERVE_SAFE_REFUSALS entry (${SERVE_CASES.map(([e]) => e).join(", ")}); the localhost http test and cascade also accepted as a plain trusted fail (R705), and the RecordRef and GetTable cases as one with BC's error (R1026); the public-host http test must be a refusal (R808); the two cascade-existing-state rows also accepted as a plain pass; a refused row no entry accepts is unkept, a gate-fail (R1000)${pinned ? "; this build's pin (R808): commit a plain pass, and no row at all for Codeunit50673.Never (onrun-failed: since #5859 a test codeunit whose OnRun raises gives no row)" : ""}; then (PR-363) one more fresh daemon and request per refusal family (${V3_KEEP_APP_FAMILIES} apps), each judged on its own rows: every chosen case a refusal under its own entry, no plain fail or pass allowed, and every refused row of the request kept`;
  // PR-363: never run the old request alone, which would read exactly as it did before the family apps.
  const keepApps = env.keepApps;
  const keepCases = keepApps?.reduce((n, a) => n + a.cases.length, 0) ?? 0;
  if (
    keepApps === undefined ||
    keepApps.length < V3_KEEP_APP_FAMILIES ||
    keepCases !== V3_KEEP_CASES
  )
    return fact(
      "serve-keep-reasons",
      "warn",
      "unmeasurable",
      expected,
      `the family apps are missing or short: ${keepApps === undefined ? "none given" : `${keepApps.length} of ${V3_KEEP_APP_FAMILIES} families, ${keepCases} of ${V3_KEEP_CASES} cases`} (PR-363; run scripts/pr363-legc-keep-apps.ts --out <dir>)`,
    );
  let rows: readonly ServerTestLine[];
  try {
    await server.start(
      SERVE_DEADLINE_MS,
      [],
      SERVE_TEST_TIMEOUT_S,
      env.environment !== undefined ? ["--environment", env.environment] : [], // R938
    );
    rows = (
      await server.runTests({ sourcePaths: [app, tests], testIsolation: "test" }, SERVE_DEADLINE_MS)
    ).tests;
  } catch (err) {
    return fact("serve-keep-reasons", "warn", "unmeasurable", expected, String(err));
  } finally {
    await server.close();
  }
  // Review (R705): a request whose apps do not compile runs nothing; every case would read "no row",
  // a mere warning, and the unkept check would be blind on that build. No row at all is unmeasurable.
  if (rows.length === 0)
    return fact(
      "serve-keep-reasons",
      "warn",
      "unmeasurable",
      expected,
      "the serve request returned no test row at all (the probe's apps may not compile on this build, R705)",
    );
  const moved: string[] = [];
  const how: string[] = [];
  const unkept: string[] = [];
  // R1000 (review): every refused row the keep rule rejects, judged or not.
  const judged = new Set(SERVE_CASES.map(([, n]) => n));
  for (const t of rows)
    if (!judged.has(t.name) && unkeptRefusal(t))
      unkept.push(`(unjudged): UNKEPT ${t.name}: ${t.message ?? "(no message)"}`);
  for (const [entry, name, plainFailOk, plainPassOk] of SERVE_CASES) {
    const r = rows.find((t) => t.name === name);
    if (unkeptRefusal(r)) {
      // R1000: before the pinned and the normal judgement, so no branch can let it through.
      unkept.push(`${entry}: UNKEPT ${name}: ${r?.message ?? "(no message)"}`);
      continue;
    }
    if (pinned && (entry === "commit" || entry === "onrun-failed")) {
      // R808: the pin says what this build gives instead of a refusal. Any other reading is a move.
      const ok =
        entry === "commit"
          ? r !== undefined && r.status === "pass" && r.notRun !== true
          : r === undefined;
      if (ok) how.push(`${entry}: ${entry === "commit" ? "plain pass" : "no row"} (pinned)`);
      else
        moved.push(
          `${entry}: MOVED ${r === undefined ? `no row ${name}` : `${r.status} notRun=${String(r.notRun)} ${r.message ?? ""}`}`,
        );
      continue;
    }
    const refusal =
      r !== undefined &&
      r.notRun === true &&
      r.status === "error" &&
      r.message !== undefined &&
      V3_SERVE_SAFE_REFUSALS[entry]?.test(r.message) === true;
    // R705: never a negated optional-chain form (r?.x !== ...): no row would read as fine.
    const pm = plainFailOk ? plainFailMessage(r) : undefined;
    const plainFail =
      pm !== undefined &&
      !isV3RefusalText(pm) &&
      (PLAIN_FAIL_TEXT[entry] === undefined || pm === PLAIN_FAIL_TEXT[entry]);
    const plainPass =
      plainPassOk &&
      r !== undefined &&
      r.status === "pass" &&
      r.notRun !== true &&
      !isV3RefusalText(r.message);
    if (refusal || plainFail || plainPass) {
      how.push(`${entry}: ${refusal ? "refusal" : plainFail ? "plain fail" : "plain pass"}`);
    } else {
      moved.push(
        `${entry}: MOVED ${r === undefined ? `no row ${name}` : `${r.status} notRun=${String(r.notRun)} ${r.message ?? ""}`}`,
      );
    }
  }
  // PR-363: each family app on its OWN fresh daemon, started as the one above, judged on its OWN rows
  // (every app names its tests `Codeunit5100x.Cell`, so rows of two requests must never be merged).
  const unmeasured: string[] = [];
  let caseCount = SERVE_CASES.length;
  for (const app of keepApps) {
    caseCount += app.cases.length;
    const fam = new AlRunnerServer(absToolPath(env.alRunnerPath), spawn, [], "serve");
    let res: Awaited<ReturnType<AlRunnerServer["runTests"]>>;
    try {
      await fam.start(
        SERVE_DEADLINE_MS,
        [],
        SERVE_TEST_TIMEOUT_S,
        env.environment !== undefined ? ["--environment", env.environment] : [],
      );
      res = await fam.runTests(
        { sourcePaths: [app.dir], testIsolation: "test" },
        SERVE_DEADLINE_MS,
      );
    } catch (err) {
      unmeasured.push(`${app.family}: ${String(err)}`);
      continue;
    } finally {
      await fam.close();
    }
    if (res.tests.length === 0) {
      unmeasured.push(
        `${app.family}: the request returned no test row at all (compilationErrors: ${JSON.stringify(res.compilationErrors)})`,
      );
      continue;
    }
    const names = new Set(app.cases.map((c) => c.name));
    for (const t of res.tests)
      if (!names.has(t.name) && unkeptRefusal(t))
        unkept.push(`${app.family} (unjudged): UNKEPT ${t.name}: ${t.message ?? "(no message)"}`);
    for (const c of app.cases) {
      const r = res.tests.find((t) => t.name === c.name);
      if (unkeptRefusal(r)) {
        unkept.push(`${app.family} ${c.entry}: UNKEPT ${c.name}: ${r?.message ?? "(no message)"}`);
        continue;
      }
      const ok =
        r !== undefined &&
        r.notRun === true &&
        r.status === "error" &&
        r.message !== undefined &&
        V3_SERVE_SAFE_REFUSALS[c.entry]?.test(r.message) === true;
      if (ok) how.push(`${c.entry}: refusal`);
      else
        moved.push(
          `${app.family} ${c.entry}: MOVED ${r === undefined ? `no row ${c.name}` : `${r.status} notRun=${String(r.notRun)} ${r.message ?? ""}`}`,
        );
    }
  }
  const verdict =
    unkept.length > 0
      ? "unkept"
      : unmeasured.length > 0
        ? "unmeasurable"
        : moved.length === 0
          ? "matches"
          : "diverged";
  return fact(
    "serve-keep-reasons",
    "warn",
    verdict,
    expected,
    unkept.length > 0
      ? [...unkept, ...unmeasured, ...moved].join("; ")
      : unmeasured.length > 0
        ? [...unmeasured, ...moved].join("; ")
        : moved.length === 0
          ? `the keep rule accepts every row of all ${caseCount} entries (${how.join(", ")})`
          : moved.join("; "),
  );
}

export interface V3ProbeEnv {
  readonly alRunnerPath: string;
  /** `.gated`'s version (or the candidate's own `--version` in the update gate). */
  readonly expectedVersion: string;
  readonly packagesDir: string;
  readonly bcVersion: string;
  /** R938: `--environment` for every probe leg that runs the tests; absent: al-runner's default. */
  readonly environment?: "saas" | "onprem";
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
  readonly startBurner?: (core: number) => { kill(): void };
  /**
   * R789 test hook: returns `/proc/stat` text (called twice, before A). With neither this nor
   * `startBurner` set, the real file is read (two samples 200 ms apart); a test that sets only
   * `startBurner` gets core 0 and never reads the real file.
   */
  readonly readProcStat?: () => Promise<string | undefined>;
  /**
   * Addendum 1 test hook: returns `/proc/self/status` text. With neither this nor `readProcStat` nor
   * `startBurner` set, the real file is read; a test that sets one of the others gets all cores allowed
   * unless it sets this.
   */
  readonly readSelfStatus?: () => Promise<string | undefined>;
  /** Test hook: `timeout-is-cpu`'s per-call hard process timeout (default 60 s). */
  readonly burnGuardMs?: number;
  /**
   * M1 (review build Opus): `timeout-is-cpu` pins burns to one core beside busy loops and takes about
   * 20 s (R693, r14b), so the fact is GATE-ONLY: the update gate's leg C measures it (this field absent), and
   * its pass is recorded with `.gated`. A session names that record here instead: the burns do not
   * run, and the fact cannot refuse a session on other hardware.
   */
  readonly gateOnlyTrusted?: string;
  /** PR-114a test hook: the deadline of one capability-fact request (default `SERVE_DEADLINE_MS`). */
  readonly serveDeadlineMs?: number;
  /**
   * PR-363: the family apps for `serve-keep-reasons` (the generator's manifest). Absent, or fewer than
   * `V3_KEEP_APP_FAMILIES`: that fact reads `unmeasurable`.
   */
  readonly keepApps?: readonly V3KeepApp[];
  /** R612 test hook: the `serve` daemon for `serve-keep-reasons` (default: the real binary). */
  readonly serveSpawn?: ServerSpawnFn;
  /**
   * R808: the build's pin (`V3BuildPin.serveKeepMoved`) is present, so `serve-keep-reasons` expects
   * `commit` as a plain pass and NO row for `onrun-failed`. The caller reads it from the pin; this
   * module does not import the pins module (that imports this one).
   */
  readonly serveKeepMoved?: boolean;
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
  /** The process's own CPU time, when the spawn gave it. */
  readonly cpuMs: number | undefined;
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

/** F4: a row fact's measured text, the rows first. Without `stackTrace` (kept on rows since R925)
 *  or `clock` (kept since PR-43): the pinned texts are a row's status and message, so neither may
 *  move them. */
const rowsText = (c: Call, method: string): string =>
  `${JSON.stringify(c.rows?.filter((r) => r.method === method).map(({ stackTrace: _, clock: _clock, ...r }) => r) ?? null)} exit ${c.exitCode}`;

/**
 * PR-114a: the eight capability facts baseline batching (PR-114b) rests on. Each runs serve requests
 * of LethAL's batch body (no `test` unless it measures one codeunit alone, the complement in
 * `excludeTests`, `testIsolation: "test"`, coverage and per-test coverage; none of `runSelectedOnly`,
 * `strictOrder` (but `batch-lane-strict-reruns`, which measures it), `testSuites`, `testRunner`,
 * `testDriver`) over its own scratch folder of invented AL, ids 50700-50779 (ten per fact).
 */
export const V3_CAPABILITY_FACTS = [
  "batch-no-cross-singleinstance",
  "batch-no-cross-library-global",
  "batch-no-cross-row",
  "batch-no-cross-subscriber",
  "batch-onrun-excluded-no-carry",
  "batch-onrun-included-duplicates",
  "batch-lane-hint-only",
  "batch-lane-strict-reruns",
] as const;

/**
 * PR-340 §4: the carry fact. It is NOT in `V3_CAPABILITY_FACTS` on purpose: those eight gate baseline
 * batching (`baselineBatchingOffReason`, the update script's record rule, DBM's seam), and a build with
 * no record of this one must read "not carry-proven", never move batching or any other fact. It is a
 * ninth batch-shaped probe fact, judged by leg C's default table (`matches`); its reading rides in the
 * receipt's and `.gated`'s `batchFacts` map beside the eight, and `carryWalkOffReason` reads it.
 * Its own server starts with `AL_STRICT_SEQUENTIAL=1`; the other facts' servers do not.
 */
export const V3_CARRY_FACT = "batch-sequential-carry";

const batchSpareAl = (id: number): string => `codeunit ${id} "Batch Spare"
{
    Subtype = Test;

    [Test]
    procedure Spare()
    begin
    end;
}
`;

const batchRowTableAl = (id: number): string => `table ${id} "Batch Row"
{
    fields
    {
        field(1; "Code"; Code[10]) { }
    }
    keys
    {
        key(PK; "Code") { Clustered = true; }
    }
}
`;

/** Writer (no OnRun) and reader that fail on a SingleInstance counter or temp table. ids b..b+4. */
const batchSingleInstanceAl = (b: number): string => `${batchRowTableAl(b)}
codeunit ${b + 1} "Batch Single State"
{
    SingleInstance = true;

    var
        Counter: Integer;
        TempRows: Record "Batch Row" temporary;

    procedure Bump()
    begin
        Counter += 1;
    end;

    procedure Count(): Integer
    begin
        exit(Counter);
    end;

    procedure AddTemp(C: Code[10])
    begin
        TempRows.Init();
        TempRows."Code" := C;
        TempRows.Insert();
    end;

    procedure TempCount(): Integer
    begin
        exit(TempRows.Count());
    end;
}

codeunit ${b + 2} "Batch Writer Tests"
{
    Subtype = Test;

    [Test]
    procedure WritesState()
    var
        S: Codeunit "Batch Single State";
    begin
        S.Bump();
        S.AddTemp('T');
    end;
}

codeunit ${b + 3} "Batch Reader Tests"
{
    Subtype = Test;

    [Test]
    procedure SeesNoCounter()
    var
        S: Codeunit "Batch Single State";
    begin
        if S.Count() <> 0 then
            Error('counter %1', S.Count());
    end;

    [Test]
    procedure SeesNoTemp()
    var
        S: Codeunit "Batch Single State";
    begin
        if S.TempCount() <> 0 then
            Error('temp rows %1', S.TempCount());
    end;
}

${batchSpareAl(b + 4)}`;

/** Writer and reader of a library codeunit's (not SingleInstance) global. ids b..b+4. */
const batchLibraryAl = (b: number): string => `codeunit ${b + 1} "Batch Library"
{
    var
        Seen: Integer;

    procedure Touch(): Integer
    begin
        Seen += 1;
        exit(Seen);
    end;
}

codeunit ${b + 2} "Batch Writer Tests"
{
    Subtype = Test;

    [Test]
    procedure WritesLibraryGlobal()
    var
        L: Codeunit "Batch Library";
    begin
        L.Touch();
    end;
}

codeunit ${b + 3} "Batch Reader Tests"
{
    Subtype = Test;

    [Test]
    procedure SeesFreshLibrary()
    var
        L: Codeunit "Batch Library";
    begin
        if L.Touch() <> 1 then
            Error('library global carried');
    end;
}

${batchSpareAl(b + 4)}`;

/** Writer that inserts a real row, and a reader that fails on it. ids b..b+4. */
const batchRowAl = (b: number): string => `${batchRowTableAl(b)}
codeunit ${b + 2} "Batch Writer Tests"
{
    Subtype = Test;

    [Test]
    procedure WritesARealRow()
    var
        R: Record "Batch Row";
    begin
        R.Init();
        R."Code" := 'W';
        R.Insert();
    end;
}

codeunit ${b + 3} "Batch Reader Tests"
{
    Subtype = Test;

    [Test]
    procedure SeesNoRealRow()
    var
        R: Record "Batch Row";
    begin
        if not R.IsEmpty() then
            Error('real rows %1', R.Count());
    end;
}

${batchSpareAl(b + 4)}`;

/** Writer that binds a manual subscriber, and a reader that fails while it is still bound. ids b..b+5. */
const batchSubscriberAl = (b: number): string => `codeunit ${b + 1} "Batch Event Source"
{
    [IntegrationEvent(false, false)]
    procedure OnPing(var Hits: Integer)
    begin
    end;

    procedure Ping(): Integer
    var
        Hits: Integer;
    begin
        OnPing(Hits);
        exit(Hits);
    end;
}

codeunit ${b + 2} "Batch Manual Subscriber"
{
    EventSubscriberInstance = Manual;

    [EventSubscriber(ObjectType::Codeunit, Codeunit::"Batch Event Source", 'OnPing', '', false, false)]
    local procedure HandlePing(var Hits: Integer)
    begin
        Hits += 1;
    end;
}

codeunit ${b + 3} "Batch Writer Tests"
{
    Subtype = Test;

    var
        Sub: Codeunit "Batch Manual Subscriber";

    [Test]
    procedure BindsASubscriber()
    begin
        BindSubscription(Sub);
    end;
}

codeunit ${b + 4} "Batch Reader Tests"
{
    Subtype = Test;

    [Test]
    procedure SeesNoBoundSubscriber()
    var
        E: Codeunit "Batch Event Source";
    begin
        if E.Ping() <> 0 then
            Error('subscriber still bound');
    end;
}

${batchSpareAl(b + 5)}`;

/** A writer WITH an OnRun that inserts a row; a reader that fails on it; an other that counts rows; a spare. ids b..b+4. */
const batchOnRunAl = (b: number): string => `table ${b} "Batch Setup"
{
    fields
    {
        field(1; "Code"; Code[10]) { }
        field(2; Value; Integer) { }
    }
    keys
    {
        key(PK; "Code") { Clustered = true; }
    }
}

codeunit ${b + 1} "Batch Writer Tests"
{
    Subtype = Test;

    trigger OnRun()
    var
        S: Record "Batch Setup";
    begin
        S.Init();
        S."Code" := 'X';
        S.Value := 7;
        S.Insert();
    end;

    [Test]
    procedure WriterSeesOwnRow()
    var
        S: Record "Batch Setup";
    begin
        if not S.Get('X') then
            Error('writer: no row');
    end;
}

codeunit ${b + 2} "Batch Reader Tests"
{
    Subtype = Test;

    [Test]
    procedure ReaderSeesNoRow()
    var
        S: Record "Batch Setup";
    begin
        if S.Get('X') then
            Error('reader: carried row %1', S.Value);
    end;
}

codeunit ${b + 3} "Batch Other Tests"
{
    Subtype = Test;

    [Test]
    procedure OtherInsertsAndSeesOne()
    var
        S: Record "Batch Setup";
    begin
        S.Init();
        S."Code" := 'Y';
        S.Insert();
        if S.Count() <> 1 then
            Error('other: count %1', S.Count());
    end;
}

${batchSpareAl(b + 4)}`;

/** A SingleInstance store, its writer and a reader that fails on a store the writer left. ids b..b+4. */
const batchLaneAl = (b: number): string => `codeunit ${b + 1} "Batch Lane Store"
{
    SingleInstance = true;

    var
        Stored: Integer;

    procedure SetValue(V: Integer)
    begin
        Stored := V;
    end;

    procedure GetValue(): Integer
    begin
        exit(Stored);
    end;
}

codeunit ${b + 2} "Batch Lane Writer"
{
    Subtype = Test;

    [Test]
    procedure StoresFive()
    var
        S: Codeunit "Batch Lane Store";
    begin
        S.SetValue(5);
    end;
}

codeunit ${b + 3} "Batch Lane Reader"
{
    Subtype = Test;

    [Test]
    procedure NeedsFive()
    var
        S: Codeunit "Batch Lane Store";
    begin
        if S.GetValue() <> 5 then
            Error('store is %1', S.GetValue());
    end;
}

${batchSpareAl(b + 4)}`;

/**
 * PR-340: a SingleInstance store, a writer that leaves 5 in it and a reader that FAILS on any store
 * not 0 (the leak detector the carry walk relies on). ids b+1 .. b+4 (the spare is b+4).
 */
const batchCarryAl = (b: number): string => `codeunit ${b + 1} "Carry Probe Store"
{
    SingleInstance = true;

    var
        Stored: Integer;

    procedure SetValue(V: Integer)
    begin
        Stored := V;
    end;

    procedure GetValue(): Integer
    begin
        exit(Stored);
    end;
}

codeunit ${b + 2} "Carry Probe Writer"
{
    Subtype = Test;

    [Test]
    procedure LeavesFive()
    var
        S: Codeunit "Carry Probe Store";
    begin
        S.SetValue(5);
    end;
}

codeunit ${b + 3} "Carry Probe Reader"
{
    Subtype = Test;

    [Test]
    procedure WantsZero()
    var
        S: Codeunit "Carry Probe Store";
    begin
        if S.GetValue() <> 0 then
            Error('carried %1', S.GetValue());
    end;
}

${batchSpareAl(b + 4)}`;

interface BatchRow {
  readonly name: string;
  readonly status: string;
  readonly message: string | undefined;
}

interface BatchAnswer {
  readonly rows: readonly BatchRow[];
  readonly hints: readonly { readonly name: string; readonly orderHint: string }[];
}

type BatchAsk = (extra: Record<string, unknown>) => Promise<BatchAnswer>;

interface BatchFactSpec {
  readonly fact: (typeof V3_CAPABILITY_FACTS)[number] | typeof V3_CARRY_FACT;
  /** PR-340: extra environment for this fact's OWN server (the carry fact only); absent: the shared server. */
  readonly serverEnv?: Readonly<Record<string, string>>;
  /** The first of the fact's ten ids. */
  readonly base: number;
  readonly al: string;
  readonly expected: string;
  readonly judge: (
    ask: BatchAsk,
  ) => Promise<{ ok: boolean; measured: string; reference?: "pass" | "fail" | "none" }>;
}

/** PR-117: the alone reference's reading: no rows is `none`, any non-pass row is `fail`. */
const referenceOf = (refs: readonly BatchRow[]): "pass" | "fail" | "none" =>
  refs.length === 0 ? "none" : refs.every((x) => x.status === "pass") ? "pass" : "fail";

const rowText = (rs: readonly BatchRow[]): string =>
  rs
    .map((r) => `${r.name}=${r.status}${r.message !== undefined ? `(${r.message})` : ""}`)
    .join(" ");
const rowsOf = (a: BatchAnswer, id: number): BatchRow[] =>
  a.rows.filter((r) => r.name.startsWith(`Codeunit${id}.`));
const sameRows = (a: readonly BatchRow[], b: readonly BatchRow[]): boolean =>
  a.length === b.length &&
  a.every(
    (r, i) => r.name === b[i]?.name && r.status === b[i]?.status && r.message === b[i]?.message,
  );

/**
 * `reader` alone is the reference: a pass on every row, and at least one row (an empty reference would
 * make "equal" true for a build that ran nothing). The batch holds the writer's rows (they ran), the
 * reader's rows equal to the reference, and no row of the excluded spare.
 */
function noCrossSpec(
  fact: BatchFactSpec["fact"],
  base: number,
  al: string,
  writer: number,
  reader: number,
  spare: number,
  what: string,
): BatchFactSpec {
  return {
    fact,
    base,
    al,
    expected: `the reader (codeunit ${reader}) gives the same rows in one batch (writer ${writer} included, spare ${spare} excluded) as alone, all passes: ${what} does not cross test codeunits in one plain request`,
    judge: async (ask) => {
      const alone = await ask({ test: `Codeunit${reader}.` });
      const batch = await ask({ excludeTests: [`Codeunit${spare}.`] });
      const ref = rowsOf(alone, reader);
      const w = rowsOf(batch, writer);
      const r = rowsOf(batch, reader);
      const ok =
        ref.length > 0 &&
        ref.every((x) => x.status === "pass") &&
        w.length > 0 &&
        w.every((x) => x.status === "pass") &&
        sameRows(r, ref) &&
        rowsOf(batch, spare).length === 0;
      // PR-117 (M2): "pass" only when the reader alone AND the writer's rows in the batch all pass; a writer that
      // fails or is missing in the batch is not "only the batch half differs", so no reference (a diverged gate-fails).
      const reference = referenceOf(ref);
      const writerFine = w.length > 0 && w.every((x) => x.status === "pass");
      return {
        ok,
        measured: `alone: ${rowText(ref)}; batch writer: ${rowText(w)}; batch reader: ${rowText(r)}`,
        ...(reference === "pass" && !writerFine ? {} : { reference }),
      };
    },
  };
}

const BATCH_FACTS: readonly BatchFactSpec[] = [
  noCrossSpec(
    "batch-no-cross-singleinstance",
    50700,
    batchSingleInstanceAl(50700),
    50702,
    50703,
    50704,
    "a SingleInstance counter or temp table",
  ),
  noCrossSpec(
    "batch-no-cross-library-global",
    50710,
    batchLibraryAl(50710),
    50712,
    50713,
    50714,
    "a library codeunit's global",
  ),
  noCrossSpec("batch-no-cross-row", 50720, batchRowAl(50720), 50722, 50723, 50724, "a real row"),
  noCrossSpec(
    "batch-no-cross-subscriber",
    50730,
    batchSubscriberAl(50730),
    50733,
    50734,
    50735,
    "a bound manual subscriber",
  ),
  {
    fact: "batch-onrun-excluded-no-carry",
    base: 50740,
    al: batchOnRunAl(50740),
    expected:
      "an OnRun writer (50741) EXCLUDED from the batch carries nothing: the reader (50742) and other (50743) give the same rows in the batch as each alone, all passes",
    judge: async (ask) => {
      const reader = await ask({ test: "Codeunit50742." });
      const other = await ask({ test: "Codeunit50743." });
      const batch = await ask({ excludeTests: ["Codeunit50741.", "Codeunit50744."] });
      const refs = [...rowsOf(reader, 50742), ...rowsOf(other, 50743)];
      const got = [...rowsOf(batch, 50742), ...rowsOf(batch, 50743)];
      const ok =
        refs.length === 2 &&
        refs.every((x) => x.status === "pass") &&
        batch.rows.length === 2 &&
        sameRows(got, refs);
      return {
        ok,
        measured: `alone: ${rowText(refs)}; batch: ${rowText(batch.rows)}`,
        reference: refs.length === 2 ? referenceOf(refs) : refs.length === 0 ? "none" : "fail",
      };
    },
  },
  {
    fact: "batch-onrun-included-duplicates",
    base: 50750,
    al: batchOnRunAl(50750),
    expected:
      "an OnRun writer (50751) INCLUDED reaches the later codeunits, and they stream a second row with the same name: the writer one row, the reader (50752) and other (50753) two each",
    judge: async (ask) => {
      // LethAL's body: a non-empty complement (the spare) in excludeTests.
      const batch = await ask({ excludeTests: ["Codeunit50754."] });
      const n = (id: number) => rowsOf(batch, id).length;
      return {
        ok: n(50751) === 1 && n(50752) === 2 && n(50753) === 2 && n(50754) === 0,
        measured: rowText(batch.rows),
      };
    },
  },
  {
    fact: "batch-lane-hint-only",
    base: 50760,
    al: batchLaneAl(50760),
    expected:
      'without strictOrder the SingleInstance lane only hints: the reader (50763) is exactly `fail` "store is 0", two rows in all, and the summary\'s orderHints names the reader and the global Stored',
    judge: async (ask) => {
      const batch = await ask({ excludeTests: ["Codeunit50764."] });
      const r = rowsOf(batch, 50763);
      const hint = batch.hints.filter((h) => h.name === "Codeunit50763.NeedsFive");
      const ok =
        batch.rows.length === 2 &&
        r.length === 1 &&
        r[0]?.status === "fail" &&
        r[0]?.message === "store is 0" &&
        hint.length === 1 &&
        hint[0]?.orderHint.includes("Stored") === true;
      return {
        ok,
        measured: `${rowText(batch.rows)}; orderHints ${JSON.stringify(batch.hints).slice(0, 300)}`,
      };
    },
  },
  {
    fact: "batch-lane-strict-reruns",
    base: 50770,
    al: batchLaneAl(50770),
    expected:
      'with strictOrder: true (NOT LethAL\'s body) the reader (50773) is re-run: a first reader row that fails with "store is 0", then a second that passes',
    judge: async (ask) => {
      const batch = await ask({ excludeTests: ["Codeunit50774."], strictOrder: true });
      const r = rowsOf(batch, 50773);
      return {
        ok:
          r.length === 2 &&
          r[0]?.status === "fail" &&
          r[0]?.message === "store is 0" &&
          r[1]?.status === "pass",
        measured: rowText(batch.rows),
      };
    },
  },
  {
    fact: V3_CARRY_FACT,
    // Its own server, started with AL_STRICT_SEQUENTIAL=1; no other fact's server gets the variable.
    serverEnv: { AL_STRICT_SEQUENTIAL: "1" },
    base: 50780,
    al: batchCarryAl(50780),
    expected:
      'with AL_STRICT_SEQUENTIAL=1 and strictOrder: true (LethAL\'s lane body: the spare in excludeTests) the writer (50782) passes and the reader (50783) runs after it ONCE and FAILS with the carried state: exactly `fail` "carried 5", two rows in all',
    judge: async (ask) => {
      const batch = await ask({ excludeTests: ["Codeunit50784."], strictOrder: true });
      const w = rowsOf(batch, 50782);
      const r = rowsOf(batch, 50783);
      return {
        ok:
          batch.rows.length === 2 &&
          w.length === 1 &&
          w[0]?.status === "pass" &&
          r.length === 1 &&
          r[0]?.status === "fail" &&
          r[0]?.message === "carried 5" &&
          batch.rows[0]?.name === w[0]?.name,
        measured: rowText(batch.rows),
      };
    },
  },
];

/**
 * PR-114a: the capability facts, one serve daemon, one scratch folder per fact. A request that
 * fails (or a daemon that will not start) reads `unmeasurable` for the facts it carried. PR-340: the
 * carry fact has its OWN daemon (`serverEnv`), so the others run exactly as before.
 */
async function batchCapabilityFacts(env: V3ProbeEnv, root: string): Promise<V3Fact[]> {
  const shared = await batchFactsOn(
    env,
    root,
    BATCH_FACTS.filter((s) => s.serverEnv === undefined),
    undefined,
  );
  const own: V3Fact[] = [];
  for (const spec of BATCH_FACTS.filter((s) => s.serverEnv !== undefined))
    own.push(...(await batchFactsOn(env, root, [spec], spec.serverEnv)));
  return [...shared, ...own];
}

async function batchFactsOn(
  env: V3ProbeEnv,
  root: string,
  specs: readonly BatchFactSpec[],
  serverEnv: Readonly<Record<string, string>> | undefined,
): Promise<V3Fact[]> {
  const cache = env.cacheDir !== undefined ? { ALRUNNER_CACHE: resolve(env.cacheDir) } : undefined;
  const spawn: ServerSpawnFn = (argv) =>
    (env.serveSpawn ?? defaultServerSpawn)(argv, {
      cwd: root,
      env: { ...v3ChildEnv(cache), ...serverEnv },
    });
  const deadline = env.serveDeadlineMs ?? SERVE_DEADLINE_MS;
  const begin = async (): Promise<AlRunnerServer> => {
    const s = new AlRunnerServer(absToolPath(env.alRunnerPath), spawn, [], "serve");
    await s.start(
      SERVE_DEADLINE_MS,
      [],
      SERVE_TEST_TIMEOUT_S,
      env.environment !== undefined ? ["--environment", env.environment] : [],
    );
    return s;
  };
  let server: AlRunnerServer | undefined;
  const out: V3Fact[] = [];
  try {
    server = await begin();
    for (const spec of specs) {
      const dir = join(root, spec.fact);
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(
        join(dir, "app.json"),
        baseAppJson({
          id: `7a1c0e52-5b8e-4d3a-9f60-2c7b8e1d${String(spec.base - 50000).padStart(4, "0")}`,
          name: `LethAL PR114 ${spec.fact}`,
          idFrom: spec.base,
          idTo: spec.base + 9,
        }),
      );
      await writeFile(join(dir, "src", "Batch.Codeunit.al"), spec.al);
      const ask: BatchAsk = async (extra) => {
        if (server === undefined) throw new Error("no serve daemon");
        const a = await server.runEntries(
          {
            command: "runTests",
            sourcePaths: [dir],
            testIsolation: "test",
            coverage: true,
            perTestCoverage: true,
            ...extra,
          },
          deadline,
        );
        const hints: unknown[] = Array.isArray(a.summary.orderHints) ? a.summary.orderHints : [];
        return {
          rows: a.tests.map((t) => ({
            name: String(t.name),
            status: String(t.status),
            message: typeof t.message === "string" ? t.message : undefined,
          })),
          hints: hints.map((h) => {
            const x = (h ?? {}) as Record<string, unknown>;
            return { name: String(x.name), orderHint: String(x.orderHint ?? "") };
          }),
        };
      };
      try {
        const j = await spec.judge(ask);
        out.push({
          ...fact(
            spec.fact,
            "capability",
            j.ok ? "matches" : "diverged",
            spec.expected,
            j.measured,
          ),
          // A fact with no alone reference by design carries none: classifyLegC judges it as before PR-117.
          ...(j.reference !== undefined ? { reference: j.reference } : {}),
        });
      } catch (err) {
        out.push(fact(spec.fact, "capability", "unmeasurable", spec.expected, String(err)));
        // M1: a request that timed out (or broke the protocol) may still be running or leave late rows and a
        // summary on the pipe, which the NEXT fact would read as its own. Stop this daemon; the next fact
        // gets a fresh one (if none starts, the outer catch marks the rest unmeasurable).
        await server?.close();
        server = undefined;
        if (spec !== specs[specs.length - 1]) server = await begin();
      }
    }
  } catch (err) {
    for (const spec of specs)
      if (!out.some((f) => f.fact === spec.fact))
        out.push(fact(spec.fact, "capability", "unmeasurable", spec.expected, String(err)));
  } finally {
    await server?.close();
  }
  return out;
}

/**
 * PR-342: the leg-C capability fact `alRunnerV3.stopGroups` needs (PR-256 rule 7, upstream #8564). GATE-ONLY: a
 * session never measures it; PR-256 reads the gate's reading from the build's record (`batchFacts`). Anything but
 * `matches` (a build without #8564 refuses the request: `diverged`) never fails the gate, it only keeps the flag off.
 */
export const STOP_GROUPS_FACT = "stop-groups";

/** PR-256's pinned text of a row the stop skipped (PR-257, measured on #8564), naming the earlier failed test. */
export const STOP_SKIP_TEXT =
  /^NotRun: out-of-scope: the test Codeunit(\d+)\.(.+?) failed before it, and stopAfterFirstFailure \(--stop-after-first-failure\) /;

/** PR-342: the probe's invented AL, ids 50780-50789. Test order is declaration order. */
const STOP_GROUPS_AL = `codeunit 50781 "Stop First Fails"
{
    Subtype = Test;

    [Test]
    procedure First()
    begin
        Error('first fails');
    end;

    [Test]
    procedure Second()
    begin
    end;
}

codeunit 50782 "Stop Same Group"
{
    Subtype = Test;

    [Test]
    procedure Other()
    begin
    end;
}

codeunit 50783 "Stop Other Group"
{
    Subtype = Test;

    [Test]
    procedure Passes()
    begin
    end;
}

codeunit 50784 "Stop After Timeout"
{
    Subtype = Test;

    [Test]
    procedure Spins()
    var
        I: Integer;
    begin
        while true do
            I += 1;
    end;

    [Test]
    procedure After()
    begin
    end;
}

codeunit 50785 "Stop After Refusal"
{
    Subtype = Test;

    [Test]
    procedure Refuses()
    var
        FldRef: FieldRef;
        C: FieldClass;
    begin
        C := FldRef.Class();
    end;

    [Test]
    procedure After()
    begin
    end;
}
`;

/** PR-342: one row of a `stop-groups` request. */
export interface StopRow {
  readonly name: string;
  readonly status: string;
  readonly notRun: boolean;
  readonly message: string | undefined;
}

/** PR-342: a request's rows; or the build's own refusal of it (an error line); or no answer (deadline, EOF, protocol). */
export type StopAnswer =
  | { readonly rows: readonly StopRow[] }
  | { readonly refused: string }
  | { readonly failed: string };

/** PR-342: the three requests, in the order they go to one daemon. */
export const STOP_GROUPS_REQUESTS = {
  /** Cases 1 and 5: group `a` (50781 fails first, then 50781.Second and the second entry 50782), group `b` (50783). */
  stop: {
    stopAfterFirstFailure: true,
    entries: [
      { id: "a1", test: "Codeunit50781.", stopGroup: "a" },
      { id: "a2", test: "Codeunit50782.", stopGroup: "a" },
      { id: "b", test: "Codeunit50783.", stopGroup: "b" },
    ],
  },
  /** Case 4: the same daemon answers a plain request after the skip. */
  follow: { entries: [{ id: "f", test: "Codeunit50783." }] },
  /** Cases 2 and 3, last (a timeout may leave the daemon busy): a timeout row and a refusal row as the first failure. */
  guard: {
    stopAfterFirstFailure: true,
    entries: [
      { id: "t", test: "Codeunit50784.", stopGroup: "t" },
      { id: "r", test: "Codeunit50785.", stopGroup: "r" },
    ],
  },
} as const;

const stopRowText = (a: StopAnswer): string =>
  "rows" in a
    ? a.rows
        .map(
          (r) =>
            `${r.name}=${r.status}${r.notRun ? "/notRun" : ""}${r.message !== undefined ? `(${r.message.slice(0, 160)})` : ""}`,
        )
        .join(" ")
    : "refused" in a
      ? `refused: ${a.refused.slice(0, 300)}`
      : `no answer: ${a.failed.slice(0, 300)}`;

/**
 * PR-342: the `stop-groups` verdict from the three answers. `matches` only when ALL hold:
 * 1. 50781.First is a plain fail, and 50781.Second and 50782.Other (a later entry of group `a`) each come back as
 *    `error`, `notRun`, with the pinned skip text naming `Codeunit50781.First`;
 * 5. 50783.Passes (group `b`) passes;
 * 4. the follow-up request on the same daemon answers 50783.Passes `pass`.
 * The build refusing a request (no #8564: "unknown field `stopGroup`") is `diverged`; no answer to `stop` or `follow`
 * is `unmeasurable`. Cases 2 and 3 never change the verdict (PR-256 treats such a skip as no kill and re-runs the ref
 * alone); whether the later test carried the skip text is RECORDED in `measured`.
 */
export function judgeStopGroups(a: {
  readonly stop: StopAnswer;
  readonly follow: StopAnswer;
  readonly guard: StopAnswer;
}): { readonly verdict: V3ContractVerdict; readonly measured: string } {
  const only = (x: StopAnswer, name: string): StopRow | undefined => {
    const rs = "rows" in x ? x.rows.filter((r) => r.name === name) : [];
    return rs.length === 1 ? rs[0] : undefined;
  };
  const skipNaming = (r: StopRow | undefined, test: string): boolean => {
    const m =
      r?.notRun === true && r.status === "error" ? STOP_SKIP_TEXT.exec(r.message ?? "") : null;
    return m !== null && `Codeunit${m[1]}.${m[2]}` === test;
  };
  const ran = (r: StopRow | undefined): string =>
    r === undefined ? "no row" : STOP_SKIP_TEXT.test(r.message ?? "") ? "SKIPPED" : "ran";
  const timeoutRow = only(a.guard, "Codeunit50784.Spins");
  const refusalRow = only(a.guard, "Codeunit50785.Refuses");
  const guardText = `after a timeout${timeoutRow !== undefined && V3_TIMEOUT_MESSAGE.test(timeoutRow.message ?? "") ? "" : " (first row not a timeout)"}: ${ran(only(a.guard, "Codeunit50784.After"))}; after a refusal${refusalRow?.notRun === true && refusalRow.status === "error" && (refusalRow.message ?? "").startsWith(`${V3_REFUSAL_PREFIX} `) ? "" : " (first row not a refusal)"}: ${ran(only(a.guard, "Codeunit50785.After"))}`;
  const measured = `stop: ${stopRowText(a.stop)}; follow: ${stopRowText(a.follow)}; guard: ${stopRowText(a.guard)}; ${guardText}`;
  if ("failed" in a.stop || "failed" in a.follow) return { verdict: "unmeasurable", measured };
  const first = only(a.stop, "Codeunit50781.First");
  const ok =
    first?.status === "fail" &&
    !first.notRun &&
    skipNaming(only(a.stop, "Codeunit50781.Second"), "Codeunit50781.First") &&
    skipNaming(only(a.stop, "Codeunit50782.Other"), "Codeunit50781.First") &&
    only(a.stop, "Codeunit50783.Passes")?.status === "pass" &&
    only(a.follow, "Codeunit50783.Passes")?.status === "pass";
  return { verdict: ok ? "matches" : "diverged", measured };
}

/** PR-342: the `stop-groups` fact on its own daemon and scratch folder (leg C only). */
async function stopGroupsFact(env: V3ProbeEnv, root: string): Promise<V3Fact> {
  const expected =
    "group a: Codeunit50781.First a plain fail, then 50781.Second and 50782.Other skipped with the pinned text naming it; group b's 50783.Passes passes; a follow-up request on the same daemon answers; after a timeout or a refusal row the later test is recorded (PR-256, #8564)";
  const dir = join(root, STOP_GROUPS_FACT);
  const cache = env.cacheDir !== undefined ? { ALRUNNER_CACHE: resolve(env.cacheDir) } : undefined;
  const spawn: ServerSpawnFn = (argv) =>
    (env.serveSpawn ?? defaultServerSpawn)(argv, { cwd: root, env: v3ChildEnv(cache) });
  let server: AlRunnerServer | undefined;
  try {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(
      join(dir, "app.json"),
      baseAppJson({
        id: "7a1c0e52-5b8e-4d3a-9f60-2c7b8e1d0780",
        name: "LethAL PR342 stop-groups",
        idFrom: 50780,
        idTo: 50789,
      }),
    );
    await writeFile(join(dir, "src", "Stop.Codeunit.al"), STOP_GROUPS_AL);
    const s = new AlRunnerServer(absToolPath(env.alRunnerPath), spawn, [], "serve");
    server = s;
    await s.start(
      SERVE_DEADLINE_MS,
      [],
      SERVE_TEST_TIMEOUT_S,
      env.environment !== undefined ? ["--environment", env.environment] : [],
    );
    const ask = async (body: Record<string, unknown>): Promise<StopAnswer> => {
      try {
        const r = await s.runEntries(
          { command: "runTests", sourcePaths: [dir], testIsolation: "test", ...body },
          env.serveDeadlineMs ?? SERVE_DEADLINE_MS,
        );
        return {
          rows: r.tests.map((t) => ({
            name: String(t.name),
            status: String(t.status),
            notRun: t.notRun === true,
            message: typeof t.message === "string" ? t.message : undefined,
          })),
        };
      } catch (err) {
        if (err instanceof AlRunnerServerRequestError && err.kind === "error")
          return { refused: err.message };
        return { failed: String(err) };
      }
    };
    const stop = await ask(STOP_GROUPS_REQUESTS.stop);
    const follow = "failed" in stop ? stop : await ask(STOP_GROUPS_REQUESTS.follow);
    const guard = "failed" in follow ? follow : await ask(STOP_GROUPS_REQUESTS.guard);
    const j = judgeStopGroups({ stop, follow, guard });
    return fact(STOP_GROUPS_FACT, "capability", j.verdict, expected, j.measured);
  } catch (err) {
    return fact(STOP_GROUPS_FACT, "capability", "unmeasurable", expected, String(err));
  } finally {
    await server?.close();
  }
}

/** The probe. Never throws for a v3 answer; a fact it could not read is `unmeasurable`. */
export async function runV3ContractProbe(env: V3ProbeEnv): Promise<V3ContractResult> {
  const root = await mkdtemp(join(tmpdir(), "lethal-r586-contract-"));
  // R645: every v3 process the probe starts runs in `root` (v3 writes coverage.cobertura.xml into
  // its cwd). Paths handed to v3 are made absolute below.
  const spawnIn = env.spawn ?? defaultSpawn;
  // R807: every process this probe starts (the binary only; the burner uses Bun.spawn) gets the pinned seed.
  const spawn: SpawnFn = (argv, opts) =>
    spawnIn(argv, { ...opts, env: { ...v3ChildEnv(), ...opts?.env }, cwd: root });
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
        ...(env.environment !== undefined ? ["--environment", env.environment] : []),
        ...args,
        ...(o.coverage === true ? ["--coverage-json", cov] : []),
        o.app ?? app,
        o.tests ?? tests,
      ];
      const t0 = monoNow();
      const signal = o.guardMs !== undefined ? AbortSignal.timeout(o.guardMs) : undefined;
      const res = await spawn(argv, {
        ...(cacheDir !== undefined ? { env: { ALRUNNER_CACHE: cacheDir } } : {}),
        ...(signal !== undefined ? { signal } : {}),
      }).catch(
        (e: unknown): Awaited<ReturnType<SpawnFn>> => ({
          exitCode: -1,
          stdout: "",
          stderr: String(e),
        }),
      );
      const wallMs = res.wallMs ?? monoNow() - t0;
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
        cpuMs: res.cpuMs,
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
      const taskset = env.tasksetPath;
      // R789: the least busy core, from two samples just before A.
      const readStat =
        env.readProcStat ??
        (env.startBurner !== undefined
          ? undefined
          : async () => readFile("/proc/stat", "utf8").catch(() => undefined));
      // Addendum 1: only the cores this process may use. A hook-driven test without `readSelfStatus`
      // allows all cores; the real read that fails or does not parse means core 0.
      const readStatus =
        env.readSelfStatus ??
        (readStat !== undefined && env.readProcStat === undefined
          ? async () => readFile("/proc/self/status", "utf8").catch(() => undefined)
          : undefined);
      const pickCore = async (): Promise<number> => {
        if (readStat === undefined) return 0;
        const statusText = readStatus !== undefined ? await readStatus() : undefined;
        const allowed = readStatus !== undefined ? parseAllowedCores(statusText) : undefined;
        if (readStatus !== undefined && allowed === undefined) return 0;
        const s1 = await readStat();
        if (env.readProcStat === undefined) await new Promise((r) => setTimeout(r, 200));
        return leastBusyCore(s1, await readStat(), allowed);
      };
      const lateMs = BURN_LIMIT_SECS * 1000 * BURN_WALL_FACTOR;
      const expected = `at N=${BURN_LIMIT_SECS}: a huge burn on one core alone is a timeout row (A, on time: a wall-clock-late A means the core was contended); the same burn beside ${BURN_BUSY_LOOPS} busy loops on that core is ALSO a timeout row, with durationMs over ${lateMs} AND over ${BURN_RELATIVE_FACTOR}x A's (B: a CPU-time stop is late in wall time; a wall-time limit stops both at the same time)`;
      const guardMs = env.burnGuardMs ?? BURN_GUARD_MS;
      const burnArgs = ["--test-timeout-secs", String(BURN_LIMIT_SECS), "--codeunit", "50656"];
      const stopped = (r: V3Row | undefined) =>
        r?.notRun === true && r.message === `Test exceeded ${BURN_LIMIT_SECS}s timeout.`;
      const callText = (c: Call, r: V3Row | undefined) =>
        `${JSON.stringify(r ?? null)} (wall ${c.wallMs} ms${c.cpuMs !== undefined ? `, cpu ${Math.round(c.cpuMs)} ms` : ""}${c.timedOut ? `, killed by the ${guardMs} ms process timeout` : ""})`;
      // A: pinned, alone.
      const runA = async () => {
        const picked = await pickCore();
        const call_ = await call(burnArgs, {
          codeunit: 50656,
          wrap: [taskset, "-c", String(picked)],
          guardMs,
        });
        return { picked, call_, row: rowOf(call_, "CpuBurnLong") };
      };
      /** Addendum 1's contended A: stopped late, and its CPU time is under a full share of its wall. */
      const contended = (x: Awaited<ReturnType<typeof runA>>): boolean =>
        !x.call_.timedOut &&
        stopped(x.row) &&
        (x.row?.durationMs ?? 0) > lateMs &&
        x.call_.cpuMs !== undefined &&
        x.call_.cpuMs < BURN_CPU_SHARE * x.call_.wallMs;
      // R822: only that reading retries, on a core picked afresh. No `diverged` path retries, and B is
      // judged as ever, against the last A, so a retry cannot turn a wall-time build into `matches`.
      let tried = await runA();
      const earlier: string[] = [];
      while (earlier.length < BURN_TRIES - 1 && contended(tried)) {
        earlier.push(
          `core ${tried.picked} contended, cpu ${Math.round(tried.call_.cpuMs ?? 0)} of wall ${tried.call_.wallMs} ms`,
        );
        tried = await runA();
      }
      const { picked: core, call_: alone, row: a } = tried;
      const pin = [taskset, "-c", String(core)];
      let verdict: V3Fact["verdict"];
      let measured = `core ${core}; A ${callText(alone, a)}`;
      if (alone.timedOut) {
        // No limit at all: a build that never stops the burn.
        verdict = "diverged";
      } else if (a === undefined) {
        verdict = "unmeasurable";
      } else if (!stopped(a)) {
        verdict = "diverged";
      } else if ((a.durationMs ?? 0) > lateMs && alone.cpuMs === undefined) {
        // Addendum 1: a late A is told apart by its CPU time; without it nothing can be said.
        verdict = "unmeasurable";
        measured += `; A late (over ${lateMs} ms) and the process CPU time was not read, B not run`;
      } else if (
        (a.durationMs ?? 0) > lateMs &&
        (alone.cpuMs ?? 0) < BURN_CPU_SHARE * alone.wallMs
      ) {
        // Addendum 1: a pinned process alone on its core uses about all of it; a shared core gives a share.
        verdict = "unmeasurable";
        measured += `; A late: core ${core} contended, cpu ${Math.round(alone.cpuMs ?? 0)} of wall ${alone.wallMs} ms, B not run`;
      } else {
        // B: the same burn beside busy loops, started before and killed after (in a finally).
        const burners: { kill(): void }[] = [];
        let shared: Call;
        try {
          for (let i = 0; i < BURN_BUSY_LOOPS; i++)
            burners.push(
              env.startBurner?.(core) ??
                Bun.spawn(burnerArgv(env.tasksetPath, core), {
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
      if (earlier.length > 0) measured += `; earlier tries of A: ${earlier.join("; ")}`;
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
    // R860 (upstream #7139): TWO forms are accepted, because the backend stops the session on both.
    // Builds up to d72d3197d run on and print the `dependency skipped:` line (R590); from a461e6310 on
    // v3 stops instead: exit 2, stderr names the app (`serve` answers with an error line; the backend
    // reads that). Every pinned build reads the old form and must keep matching. The new form is read
    // by the backend's own `v3MissingDependencyStop`, so this fact cannot match text a real run would
    // not stop on (a reworded header, or `dependency cycle` naming the app). `serve`'s form is NOT
    // measured here (R860); the backend reads it.
    const stopsByName =
      v3MissingDependencyStop(ds.exitCode, ds.stderr)?.apps.some((a) =>
        a.includes(ABSENT_DEP.name),
      ) === true;
    const skipsByName = skipLines.some((l) => l.includes(ABSENT_DEP.name));
    facts.push(
      fact(
        "dependency-skip-line",
        "contract",
        ds.exitCode === -1 ? "unmeasurable" : skipsByName || stopsByName ? "matches" : "diverged",
        `stderr has a line starting "dependency skipped:" that names ${ABSENT_DEP.name}, OR the run stops with exit 2 and the header "N dependency app(s) were not found and --no-download is set" with a line naming ${ABSENT_DEP.name} (R860)`,
        `exit ${ds.exitCode}; ${skipLines.length > 0 ? JSON.stringify(skipLines[0]) : stopsByName ? `stopped by name: ${JSON.stringify(ds.stderr.slice(0, 300))}` : `no such line; stderr ${JSON.stringify(ds.stderr.slice(-300))}`}`,
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
    // PR-114a: the eight capability facts (batch carry and the SingleInstance lane); never a refusal.
    facts.push(...(await batchCapabilityFacts(env, root)));
    // PR-342: stop-groups, GATE-ONLY (PR-256 reads the gate's reading from the build's record, never a session's).
    if (env.gateOnlyTrusted === undefined) facts.push(await stopGroupsFact(env, root));
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
        // PR-43: rows now carry `clock`; it is left out here so the measured text keeps the shape
        // the build pins match (R586c), which predate the field.
        `N=3: ${sleepN.wallMs} ms ${JSON.stringify(sleepN.rows?.map(({ clock: _clock, ...r }) => r) ?? null).slice(0, 250)}; no flag: ${sleepFree.wallMs} ms`,
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
      // R938: the mask probe stays on al-runner's default environment: it reads which `#if` symbols
      // the compiler predefines, which no environment changes.
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
