import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultServerSpawn } from "./al-runner-backend";
import {
  type AlRunnerCanaryFsOps,
  baseAppJson,
  cleanUpQuietly,
  defaultFsOps,
} from "./al-runner-canary";
import { labelInsideDir, parseCobertura } from "./al-runner-coverage";
import { AlRunnerServer, type ServerCoverageFile, type ServerSpawnFn } from "./al-runner-server";
import { OneShotTransport, parseAlRunnerBcBuild, qualifiedTestName } from "./al-runner-transport";
import { type SpawnFn, defaultSpawn } from "./publisher";

/**
 * R407: does THIS al-runner report every object of a multi-object file in the frame LethAL reads?
 * Asked once per session, only when the project holds a multi-object file and coverage is
 * `"al-runner"` (`applyAlRunnerCoverageGuard`, cli.ts), on the transport the session will use.
 *
 * WHY A PROBE. On v2.12.0-main.c39ad5de al-runner compiled LethAL's instrumented bundle, found a
 * source project with the same app id beside the test app, labelled coverage with the SOURCE path,
 * and reported every object after a file's first at (previous object's end in the SOURCE) +
 * (distance in the INSTRUMENTED text) (R383). Upstream #5249 fixed it (in 43f76177 and later,
 * measured R-407 step 1), but a host may still run an older build. A known-build list would trust a
 * build nobody measured; this measures the build in hand.
 *
 * THE LAYOUT reproduces the shape that broke, under `<root>` (al-runner's cwd):
 * - `src/` is the SOURCE target: app id `PROBE_TARGET_APP_ID`, versions copied from the project's
 *   app.json, and `R407Pair.Table.al` in its SHORT form;
 * - `inst/active/` is the bundle al-runner is handed: the same app id, the same file in its LONG
 *   form (Probe A's trigger has extra statements, as instrumentation adds them);
 * - `inst/batch-1/` is a batch sibling with the same app id and the same long file (R219 measured
 *   batch labels on c39ad5de);
 * - `tests/` depends on the target by id and calls `Probe B.Reached` only. No `.alpackages`.
 * Probe A is a TABLE with a trigger with code (a non-codeunit object with code), Probe B a codeunit.
 *
 * ADMITTED only when all of these hold, each its own oracle:
 * 1. the run completed, the one probe test passed, and coverage for the pair file was read;
 * 2. every label naming the pair file resolves inside `<root>/inst/active/` (never `src/` or
 *    `inst/batch-1/`; one-shot labels are relative to the cwd, server labels absolute);
 * 3. Probe A, the first object, has no hit;
 * 4. Probe B's hit lines equal `FRAME_PROBE_EXPECTED_B_LINES`, MEASURED on 43f76177 (the committed
 *    capture under `tests/fixtures/r407-frame-probe/`), never derived by reasoning.
 * Anything else is `refused`, with a named reason. A deadline is its own refusal. An al-runner
 * outcome NEVER throws; a caller-contract violation (no al-runner path, no project app.json) does.
 *
 * THE LIMIT: the probe sees only its own layout. One-shot has no per-session line check, so a build
 * that labelled correctly but numbered wrongly in a layout unlike this one would pass. The batch
 * sibling and the table-first file narrow that; `--server` sessions also have the procedure check
 * (`alRunnerCoverageFromServer`).
 */

export const FRAME_PROBE_FILE = "R407Pair.Table.al";
const PROBE_TARGET_APP_ID = "4c07e2a9-6d1b-4e53-9a8f-0e5b7d3c2407";
const PROBE_TESTS_APP_ID = "9b3d5f71-2e8c-4a06-b7d4-6c1a0f9e8407";
const PROBE_A_TABLE_ID = 50407;
const PROBE_B_CODEUNIT_ID = 50408;
const PROBE_TESTS_CODEUNIT_ID = 50409;
const PROBE_METHOD = "ProbeReached";
/** How many statements the instrumented form adds to Probe A's trigger. */
const EXTRA_A_STATEMENTS = 12;

export const AL_RUNNER_FRAME_PROBE_TEST = qualifiedTestName(PROBE_TESTS_CODEUNIT_ID, PROBE_METHOD);

/** The pair file: Probe A (a table with an OnInsert trigger), then Probe B (a codeunit). */
function pairAl(extraStatements: number): string {
  const extra = Array.from({ length: extraStatements }, () => "        Amount := Amount + 1;\n");
  return `table ${PROBE_A_TABLE_ID} "LethAL R407 Probe A"
{
    DataClassification = SystemMetadata;

    fields
    {
        field(1; "Code"; Code[20])
        {
        }
        field(2; Amount; Integer)
        {
        }
    }

    keys
    {
        key(PK; "Code")
        {
            Clustered = true;
        }
    }

    trigger OnInsert()
    begin
        Amount := Amount + 1;
${extra.join("")}    end;
}

codeunit ${PROBE_B_CODEUNIT_ID} "LethAL R407 Probe B"
{
    procedure Reached(X: Integer): Integer
    begin
        if X > 10 then
            exit(X + 1);
        exit(X);
    end;
}
`;
}

/** The SOURCE form (`src/`). */
export const FRAME_PROBE_SOURCE_AL = pairAl(0);
/** The INSTRUMENTED form (`inst/active/`, `inst/batch-1/`): Probe A longer by the extra statements. */
export const FRAME_PROBE_INSTRUMENTED_AL = pairAl(EXTRA_A_STATEMENTS);
/** Probe B's declaration line in the instrumented form; every line before it is Probe A's. */
export const FRAME_PROBE_B_START_LINE =
  FRAME_PROBE_INSTRUMENTED_AL.split("\n").findIndex((l) => l.startsWith("codeunit ")) + 1;
/**
 * Probe B's hit lines in the instrumented frame, MEASURED on al-runner v2.12.0-main.43f76177 on both
 * transports (`tests/fixtures/r407-frame-probe/`; a test pins this constant against those captures).
 */
export const FRAME_PROBE_EXPECTED_B_LINES: readonly number[] = [45, 46, 47];

const PROBE_TESTS_AL = `codeunit ${PROBE_TESTS_CODEUNIT_ID} "LethAL R407 Probe Tests"
{
    Subtype = Test;

    [Test]
    procedure ${PROBE_METHOD}()
    var
        B: Codeunit "LethAL R407 Probe B";
    begin
        if B.Reached(20) <> 21 then
            Error('Reached(20) must be 21');
        if B.Reached(5) <> 5 then
            Error('Reached(5) must be 5');
    end;
}
`;

/** The probe's directories under `root`. */
export function frameProbeLayout(root: string) {
  return {
    sourceDir: join(root, "src"),
    bundleDir: join(root, "inst", "active"),
    batchDir: join(root, "inst", "batch-1"),
    testDir: join(root, "tests"),
  };
}

/** The `application`/`platform`/`runtime` the project declares, so the probe resolves the same BC. */
async function projectVersions(projectDir: string): Promise<Record<string, string>> {
  const manifest = JSON.parse(await readFile(join(projectDir, "app.json"), "utf8")) as Record<
    string,
    unknown
  >;
  const out: Record<string, string> = {};
  for (const k of ["application", "platform", "runtime"]) {
    const v = manifest[k];
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function appJson(
  base: Parameters<typeof baseAppJson>[0],
  versions: Record<string, string>,
  version: string,
): string {
  const json = {
    ...(JSON.parse(baseAppJson(base)) as Record<string, unknown>),
    ...versions,
    version,
  };
  return `${JSON.stringify(json, null, 2)}\n`;
}

/** Writes the probe project under `root`; exported so the layout can be compiled and inspected. */
export async function writeFrameProbeProject(root: string, projectDir: string): Promise<void> {
  const versions = await projectVersions(projectDir);
  const { sourceDir, bundleDir, batchDir, testDir } = frameProbeLayout(root);
  const targetName = "LethAL R407 Frame Probe Target";
  const target = {
    id: PROBE_TARGET_APP_ID,
    name: targetName,
    idFrom: PROBE_A_TABLE_ID,
    idTo: PROBE_B_CODEUNIT_ID,
  };
  const targets: [string, string, string][] = [
    [sourceDir, FRAME_PROBE_SOURCE_AL, "1.0.0.0"],
    // A session mints a newer version for every instrumented publish.
    [bundleDir, FRAME_PROBE_INSTRUMENTED_AL, "1.0.20000.1"],
    [batchDir, FRAME_PROBE_INSTRUMENTED_AL, "1.0.20000.1"],
  ];
  for (const [dir, text, version] of targets) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "app.json"), appJson(target, versions, version), "utf8");
    await writeFile(join(dir, FRAME_PROBE_FILE), text, "utf8");
  }
  await mkdir(testDir, { recursive: true });
  await writeFile(
    join(testDir, "app.json"),
    appJson(
      {
        id: PROBE_TESTS_APP_ID,
        name: "LethAL R407 Frame Probe Tests",
        idFrom: PROBE_TESTS_CODEUNIT_ID,
        idTo: PROBE_TESTS_CODEUNIT_ID,
        dependencies: [
          { id: PROBE_TARGET_APP_ID, name: targetName, publisher: "LethAL", version: "1.0.0.0" },
        ],
      },
      versions,
      "1.0.0.0",
    ),
    "utf8",
  );
  await writeFile(join(testDir, "R407ProbeTests.Codeunit.al"), PROBE_TESTS_AL, "utf8");
}

export type FrameProbeTransport = "one-shot" | "server";

/** Why a probe refused. One name per oracle, plus the ways a run can fail to answer. */
export type FrameProbeRefusal =
  | "deadline"
  | "run-failed"
  | "test-not-passed"
  | "no-coverage"
  | "label-outside-bundle"
  | "first-object-hit"
  | "lines-differ";

export type AlRunnerFrameProbeResult =
  | {
      readonly outcome: "admitted";
      readonly transport: FrameProbeTransport;
      /** The al-runner line naming its build (`al-runner <ver> · BC <build> ...`), if it printed one. */
      readonly build: string | undefined;
      readonly lines: readonly number[];
      readonly labels: readonly string[];
    }
  | {
      readonly outcome: "refused";
      readonly transport: FrameProbeTransport;
      readonly build: string | undefined;
      readonly refusal: FrameProbeRefusal;
      readonly reason: string;
    };

export interface AlRunnerFrameProbeRequest {
  readonly alRunnerPath: string;
  /** The project whose app.json versions the probe copies. */
  readonly projectDir: string;
  readonly serverMode: boolean;
  /** One-shot only: the session's R147 pin. The daemon never takes it (R242). */
  readonly platformAppsDir?: string;
  readonly packagesDir?: string;
  readonly preprocessorSymbols?: readonly string[];
  readonly spawn?: SpawnFn;
  readonly serverSpawn?: ServerSpawnFn;
  readonly fsOps?: AlRunnerCanaryFsOps;
  readonly deadlineMs?: number;
}

const PROBE_TEST_TIMEOUT_SECONDS = 60;
// Generous: an unpinned daemon may provision artifacts inside this call.
const PROBE_DEADLINE_MS = 15 * 60 * 1000;

/** One coverage row of the pair file: its label (verbatim) and a hit line. */
interface PairRow {
  readonly label: string;
  readonly line: number;
  readonly hits: number;
}

const isPairLabel = (label: string): boolean =>
  (label.replace(/\\/g, "/").split("/").pop() ?? "").toLowerCase() ===
  FRAME_PROBE_FILE.toLowerCase();

/**
 * The oracles, over the pair file's rows. Exported so each can be tested on a synthetic capture.
 * `root` is the probe's cwd, against which a relative (one-shot) label is resolved.
 */
export function judgeFrameProbeRows(
  rows: readonly PairRow[],
  root: string,
):
  | { readonly ok: true; readonly lines: readonly number[]; readonly labels: readonly string[] }
  | { readonly ok: false; readonly refusal: FrameProbeRefusal; readonly reason: string } {
  const pair = rows.filter((r) => isPairLabel(r.label));
  const labels = [...new Set(pair.map((r) => r.label))].sort();
  if (labels.length === 0) {
    return {
      ok: false,
      refusal: "no-coverage",
      reason: `no coverage row names ${FRAME_PROBE_FILE}`,
    };
  }
  const { bundleDir } = frameProbeLayout(root);
  const outside = labels.filter((l) => !labelInsideDir(l, bundleDir, root));
  if (outside.length > 0) {
    return {
      ok: false,
      refusal: "label-outside-bundle",
      reason: `coverage for ${FRAME_PROBE_FILE} is labelled ${outside.join(", ")}, outside the bundle al-runner was handed (${bundleDir})`,
    };
  }
  const hit = [...new Set(pair.filter((r) => r.hits > 0).map((r) => r.line))].sort((a, b) => a - b);
  const inA = hit.filter((l) => l < FRAME_PROBE_B_START_LINE);
  if (inA.length > 0) {
    return {
      ok: false,
      refusal: "first-object-hit",
      reason: `lines ${inA.join(", ")} of Probe A (lines 1-${FRAME_PROBE_B_START_LINE - 1}) were reported hit, though no test reaches it`,
    };
  }
  const want = FRAME_PROBE_EXPECTED_B_LINES;
  if (hit.length !== want.length || hit.some((l, i) => l !== want[i])) {
    return {
      ok: false,
      refusal: "lines-differ",
      reason: `Probe B was reported hit at lines [${hit.join(", ")}], expected [${want.join(", ")}] (measured on 43f76177)`,
    };
  }
  return { ok: true, lines: hit, labels };
}

/** The server's per-test coverage for the probe test, as rows. */
export function serverPairRows(coverage: readonly ServerCoverageFile[]): PairRow[] {
  return coverage.flatMap((f) =>
    (f.statements ?? []).flatMap((s) =>
      s.line !== undefined ? [{ label: f.file, line: s.line, hits: s.hits ?? 0 }] : [],
    ),
  );
}

/**
 * Runs the probe. Never throws for an al-runner outcome: every one is `refused`, with a reason.
 */
export async function probeAlRunnerCoverageFrame(
  req: AlRunnerFrameProbeRequest,
): Promise<AlRunnerFrameProbeResult> {
  if (req.alRunnerPath === "") {
    throw new Error("probeAlRunnerCoverageFrame: no al-runner path given (R407)");
  }
  const transport: FrameProbeTransport = req.serverMode ? "server" : "one-shot";
  const fsOps = req.fsOps ?? defaultFsOps;
  const root = await fsOps.mkdtemp(join(tmpdir(), "lethal-r407-frame-probe-"));
  try {
    // A project without a readable app.json is a caller error, so this throws.
    await writeFrameProbeProject(root, req.projectDir);
    const deadlineMs = req.deadlineMs ?? PROBE_DEADLINE_MS;
    const started = Date.now();
    let answer: {
      build: string | undefined;
      rows?: PairRow[];
      failure?: [FrameProbeRefusal, string];
    };
    try {
      answer = req.serverMode
        ? await viaServer(req, root, deadlineMs)
        : await viaOneShot(req, root, deadlineMs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const late = Date.now() - started >= deadlineMs;
      answer = {
        build: undefined,
        failure: late
          ? ["deadline", `the probe did not finish within ${deadlineMs} ms (${message})`]
          : ["run-failed", message],
      };
    }
    const { build } = answer;
    if (answer.failure !== undefined) {
      const [refusal, reason] = answer.failure;
      return { outcome: "refused", transport, build, refusal, reason };
    }
    const judged = judgeFrameProbeRows(answer.rows ?? [], root);
    return judged.ok
      ? { outcome: "admitted", transport, build, lines: judged.lines, labels: judged.labels }
      : { outcome: "refused", transport, build, refusal: judged.refusal, reason: judged.reason };
  } finally {
    await cleanUpQuietly(root, fsOps, "al-runner coverage-frame probe (R407)");
  }
}

const tail = (s: string): string => (s.length > 600 ? `...${s.slice(-600)}` : s);

async function viaOneShot(
  req: AlRunnerFrameProbeRequest,
  root: string,
  deadlineMs: number,
): Promise<{ build: string | undefined; rows?: PairRow[]; failure?: [FrameProbeRefusal, string] }> {
  const spawn = req.spawn ?? defaultSpawn;
  // cwd = root, so the Cobertura labels (cwd-relative) have one meaning.
  const transport = new OneShotTransport(req.alRunnerPath, (argv, o) =>
    spawn(argv, { ...o, cwd: root }),
  );
  const { bundleDir, testDir } = frameProbeLayout(root);
  const coverageOut = join(root, "coverage.xml");
  const res = await transport.send({
    sourceDir: bundleDir,
    testDir,
    qualifiedTest: AL_RUNNER_FRAME_PROBE_TEST,
    testTimeoutSeconds: PROBE_TEST_TIMEOUT_SECONDS,
    deadlineMs,
    coverageOut,
    ...(req.packagesDir !== undefined ? { packagesDir: req.packagesDir } : {}),
    ...(req.platformAppsDir !== undefined ? { platformAppsDir: req.platformAppsDir } : {}),
    ...(req.preprocessorSymbols !== undefined && req.preprocessorSymbols.length > 0
      ? { preprocessorSymbols: req.preprocessorSymbols }
      : {}),
  });
  const build = transport.observedBcBuild()?.announcement;
  if (res.kind === "deadline") {
    return { build, failure: ["deadline", `the probe did not finish within ${deadlineMs} ms`] };
  }
  if (res.kind === "error") return { build, failure: ["run-failed", tail(res.detail)] };
  const notPassed = testNotPassed(res.tests);
  if (notPassed !== undefined) return { build, failure: ["test-not-passed", notPassed] };
  let xml: string;
  try {
    xml = await readFile(coverageOut, "utf8");
  } catch {
    return { build, failure: ["no-coverage", `al-runner wrote no coverage file (${coverageOut})`] };
  }
  return {
    build,
    rows: parseCobertura(xml).map((l) => ({ label: l.file, line: l.line, hits: l.hits })),
  };
}

async function viaServer(
  req: AlRunnerFrameProbeRequest,
  root: string,
  deadlineMs: number,
): Promise<{ build: string | undefined; rows?: PairRow[]; failure?: [FrameProbeRefusal, string] }> {
  const spawn = req.serverSpawn ?? defaultServerSpawn;
  const server = new AlRunnerServer(
    req.alRunnerPath,
    (argv) => spawn(argv, { cwd: root }),
    req.preprocessorSymbols ?? [],
  );
  const { bundleDir, testDir } = frameProbeLayout(root);
  const started = Date.now();
  const packagePaths = req.packagesDir !== undefined ? [req.packagesDir] : [];
  try {
    await server.start(deadlineMs, packagePaths, PROBE_TEST_TIMEOUT_SECONDS);
    const res = await server.runTests(
      {
        sourcePaths: [bundleDir, testDir],
        ...(req.packagesDir !== undefined ? { packagePaths } : {}),
        testIsolation: "test",
        coverage: true,
        perTestCoverage: true,
      },
      Math.max(1, deadlineMs - (Date.now() - started)),
    );
    const build = await serverBanner(req, server.stderrSoFar());
    const notPassed = testNotPassed(res.tests);
    if (notPassed !== undefined) return { build, failure: ["test-not-passed", notPassed] };
    const entry = res.perTestCoverage.find((p) => p.test === AL_RUNNER_FRAME_PROBE_TEST);
    if (entry === undefined) {
      return {
        build,
        failure: [
          "no-coverage",
          `the daemon returned no per-test coverage for ${AL_RUNNER_FRAME_PROBE_TEST}`,
        ],
      };
    }
    return { build, rows: serverPairRows(entry.coverage ?? []) };
  } finally {
    await server.close();
  }
}

/**
 * The daemon names only its BC build (`[bc] selected BC ...`, measured on 43f76177), not its own,
 * so the al-runner version comes from one `--version` call beside it.
 */
async function serverBanner(
  req: AlRunnerFrameProbeRequest,
  stderr: string,
): Promise<string | undefined> {
  const bc = parseAlRunnerBcBuild(stderr)?.announcement;
  const v = await (req.spawn ?? defaultSpawn)([req.alRunnerPath, "--version"]).catch(
    () => undefined,
  );
  const version = v?.exitCode === 0 ? v.stdout.trim().split("\n")[0]?.trim() : undefined;
  const parts = [version, bc].filter((x): x is string => x !== undefined && x !== "");
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** `undefined` when exactly the probe test ran and passed; otherwise why not. */
function testNotPassed(
  tests: readonly { readonly name: string; readonly status: string; readonly message?: string }[],
): string | undefined {
  const t = tests.find((x) => x.name === AL_RUNNER_FRAME_PROBE_TEST);
  if (t === undefined) {
    return `no result for ${AL_RUNNER_FRAME_PROBE_TEST} (got: ${tests.map((x) => x.name).join(", ") || "<no tests>"})`;
  }
  if (t.status !== "pass") {
    return `${AL_RUNNER_FRAME_PROBE_TEST} reported "${t.status}"${t.message !== undefined ? `: ${tail(t.message)}` : ""}`;
  }
  return undefined;
}
