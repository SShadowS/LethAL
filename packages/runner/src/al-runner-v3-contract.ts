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
 *   re-measures and pre-commits (plan §6, §7).
 */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseAppJson } from "./al-runner-canary";
import { type V3Row, decodeV3Rows } from "./al-runner-v3-backend";
import { probeV3PredefinedSymbols } from "./al-runner-v3-probe";
import { AlcCompileError, ArtifactCompiler, type ArtifactIo, defaultArtifactIo } from "./artifact";
import { type SpawnFn, defaultSpawn } from "./publisher";

export type V3ContractVerdict = "matches" | "diverged" | "unmeasurable";
export type V3DefectVerdict = "defect-present" | "gone" | "unmeasurable";

export interface V3Fact {
  readonly fact: string;
  readonly kind: "contract" | "defect";
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

    procedure WallSpin(Ms: Integer)
    var
        Started: DateTime;
        I: Integer;
    begin
        Started := CurrentDateTime();
        while CurrentDateTime() - Started < Ms do
            I += 1;
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

codeunit 50656 "Probe Wall"
{
    Subtype = Test;

    [Test]
    procedure WallSpin3s()
    var
        Logic: Codeunit "Probe Logic";
    begin
        Logic.WallSpin(3000);
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
  /** Test hook: the competing busy loop on core 0 (default: `taskset -c 0 sh -c 'while :; do :; done'`). */
  readonly startBurner?: () => { kill(): void };
}

interface Call {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly wallMs: number;
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
  return { app, tests };
}

const fact = (
  name: string,
  kind: "contract" | "defect",
  verdict: V3Fact["verdict"],
  expected: string,
  measured: string,
): V3Fact => ({ fact: name, kind, verdict, expected, measured: measured.slice(0, 600) });

const rowOf = (c: Call | undefined, method: string): V3Row | undefined =>
  c?.rows?.find((r) => r.method === method);

/** The probe. Never throws for a v3 answer; a fact it could not read is `unmeasurable`. */
export async function runV3ContractProbe(env: V3ProbeEnv): Promise<V3ContractResult> {
  const spawn = env.spawn ?? defaultSpawn;
  const root = await mkdtemp(join(tmpdir(), "lethal-r586-contract-"));
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
      } = {},
    ): Promise<Call> => {
      seq += 1;
      const cov = join(root, `cov-${seq}.json`);
      const argv = [
        ...(o.wrap ?? []),
        env.alRunnerPath,
        "test",
        "--output-json",
        "--isolation",
        "test",
        "--package-cache",
        env.packagesDir,
        "--bc-version",
        env.bcVersion,
        "--no-download",
        ...args,
        ...(o.coverage === true ? ["--coverage-json", cov] : []),
        o.app ?? app,
        o.tests ?? tests,
      ];
      const t0 = Date.now();
      const res = await spawn(
        argv,
        env.cacheDir !== undefined ? { env: { ALRUNNER_CACHE: env.cacheDir } } : {},
      ).catch((e: unknown) => ({ exitCode: -1, stdout: "", stderr: String(e) }));
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
        rows: decoded !== undefined && "rows" in decoded ? decoded.rows : undefined,
        coverage,
      };
    };

    // version
    const v = await spawn([env.alRunnerPath, "--version"]).catch(() => ({
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
      env.alRunnerPath,
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
    // none-selected-exit (#5613)
    const none = await call(["--codeunit", "0"]);
    facts.push(
      fact(
        "none-selected-exit",
        "contract",
        none.exitCode === 6 && none.stdout.trim() === "" ? "matches" : "diverged",
        "--codeunit 0: exit 6, no document",
        `exit ${none.exitCode}, stdout ${none.stdout.trim() === "" ? "empty" : "non-empty"}`,
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
    // timeout-is-cpu (lane ruling 2026-10-21, a deviation from plan §8's calibrated 1.7 s CPU loop
    // at N=3): codeunit 50656's `WallSpin3s` spins on CurrentDateTime for 3 s of WALL time.
    //   alone:  `<v3> test --output-json --isolation test ... --test-timeout-secs 2 --codeunit 50656`
    //           -> it burns about 3 s of CPU: a notRun row "Test exceeded 2s timeout.";
    //   shared: the same argv under `taskset -c 0`, beside `taskset -c 0 sh -c 'while :; do :; done'`
    //           -> it burns about half (1.5 s of CPU) in its 3 s: a pass.
    // A wall-time stop would stop both; a CPU-time stop separates them in both directions.
    if (env.tasksetPath === undefined) {
      facts.push(
        fact("timeout-is-cpu", "contract", "unmeasurable", "taskset available", "no taskset"),
      );
    } else {
      const alone = await call(["--test-timeout-secs", "2", "--codeunit", "50656"], {
        codeunit: 50656,
      });
      const burner =
        env.startBurner?.() ??
        Bun.spawn([env.tasksetPath, "-c", "0", "sh", "-c", "while :; do :; done"], {
          stdout: "ignore",
          stderr: "ignore",
        });
      let shared: Call;
      try {
        shared = await call(["--test-timeout-secs", "2", "--codeunit", "50656"], {
          codeunit: 50656,
          wrap: [env.tasksetPath, "-c", "0"],
        });
      } finally {
        burner.kill();
      }
      const a = rowOf(alone, "WallSpin3s");
      const s = rowOf(shared, "WallSpin3s");
      const ok =
        a?.notRun === true &&
        a.message === "Test exceeded 2s timeout." &&
        s?.status === "pass" &&
        !s.notRun;
      facts.push(
        fact(
          "timeout-is-cpu",
          "contract",
          a === undefined || s === undefined ? "unmeasurable" : ok ? "matches" : "diverged",
          "a 3 s wall spin at N=2: a timeout row alone; a pass on one core shared with a busy loop",
          `alone ${JSON.stringify(a ?? null)} (${alone.wallMs} ms); shared ${JSON.stringify(s ?? null)} (${shared.wallMs} ms)`,
        ),
      );
    }
    // refusal-row-shape and refusal-cascade (#5610)
    const ref = await call(["--codeunit", "50653"], { codeunit: 50653 });
    const http = rowOf(ref, "HttpGet");
    facts.push(
      fact(
        "refusal-row-shape",
        "contract",
        ref.exitCode === 7 &&
          http?.notRun === true &&
          (http.message ?? "").startsWith("NotRun: out-of-scope: ")
          ? "matches"
          : "diverged",
        'HttpGet: exit 7, notRun, "NotRun: out-of-scope: ..."',
        `exit ${ref.exitCode} ${JSON.stringify(http ?? null)}`,
      ),
    );
    const later = rowOf(ref, "LaterFails");
    facts.push(
      fact(
        "refusal-cascade",
        "defect",
        later === undefined ? "unmeasurable" : later.notRun ? "defect-present" : "gone",
        "LaterFails (an Error after a refused test) is notRun",
        JSON.stringify(later ?? null),
      ),
    );
    // commit-under-test-isolation (#5607)
    const commit = await call(["--codeunit", "50657"], { codeunit: 50657 });
    const c = rowOf(commit, "CommitCall");
    facts.push(
      fact(
        "commit-under-test-isolation",
        "defect",
        c === undefined ? "unmeasurable" : c.notRun ? "defect-present" : "gone",
        "CommitCall under --isolation test is notRun",
        JSON.stringify(c ?? null),
      ),
    );
    // duplicate-key-insert-raises (#5603): BC raises on the second statement-form Insert.
    const keys = await call(["--codeunit", "50655"], { codeunit: 50655 });
    const k = rowOf(keys, "DuplicateNamedKey");
    facts.push(
      fact(
        "duplicate-key-insert-raises",
        "defect",
        k === undefined
          ? "unmeasurable"
          : k.status === "pass"
            ? "defect-present"
            : k.status === "fail"
              ? "gone"
              : "unmeasurable",
        "DuplicateNamedKey passes (BC raises a duplicate key)",
        JSON.stringify(k ?? null),
      ),
    );
    // sleep-is-noop (#5605) and sleep-line-covered, on codeunit 50660 (no CPU-bound sibling).
    const sleepN = await call(["--test-timeout-secs", "3", "--codeunit", "50660"], {
      coverage: true,
      codeunit: 50660,
    });
    const sleepFree = await call(["--codeunit", "50660"], { codeunit: 50660 });
    const noop = (cl: Call): boolean | undefined => {
      if (cl.rows === undefined) return undefined;
      const passes = ["ShortSleep", "LongSleepA", "LongSleepB", "SleeperDoubles"].every((m) => {
        const r = rowOf(cl, m);
        return r?.status === "pass" && !r.notRun && r.durationMs === 0;
      });
      const after = /^after sleep (\d+)/.exec(rowOf(cl, "LongSleepThenAssert")?.message ?? "");
      return cl.wallMs < 1000 && passes && after !== null && Number(after[1]) < 1000;
    };
    const n1 = noop(sleepN);
    const n2 = noop(sleepFree);
    facts.push(
      fact(
        "sleep-is-noop",
        "defect",
        n1 === undefined || n2 === undefined
          ? "unmeasurable"
          : n1 && n2
            ? "defect-present"
            : "gone",
        "codeunit 50660 with N=3 and with no flag: under 1 s of wall, Sleep tests pass in 0 ms, LongSleepThenAssert fails 'after sleep <n>', n < 1000",
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

/** Every contract fact that is not `matches`; each refuses the session. */
export function v3ContractRefusals(r: V3ContractResult): string[] {
  return r.facts
    .filter((f) => f.kind === "contract" && f.verdict !== "matches")
    .map(
      (f) =>
        `[lethal] al-runner-v3 contract ${f.verdict.toUpperCase()} — ${f.fact}\n    expected: ${f.expected}\n    measured: ${f.measured}\n    Re-measure (plan §8) before changing code; the pinned build is in .gated (R586).`,
    );
}

/** The `al-runner-v3-defect-gone` lines; they change nothing until a human re-measures. */
export function v3DefectsGone(r: V3ContractResult): string[] {
  return r.facts
    .filter((f) => f.kind === "defect" && f.verdict === "gone")
    .map(
      (f) =>
        `[lethal] al-runner-v3-defect-gone: ${f.fact}: re-measure before relying on it (measured ${f.measured})`,
    );
}

/** One line per session: the contract its verdicts were produced under. */
export function v3ContractSummary(r: V3ContractResult): string {
  return `al-runner-v3 contract: ${r.facts.map((f) => `${f.fact}=${f.verdict}`).join(", ")}`;
}
