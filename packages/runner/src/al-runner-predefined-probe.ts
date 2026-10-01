import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  type AlRunnerCanaryFsOps,
  baseAppJson,
  cleanUpQuietly,
  defaultFsOps,
} from "./al-runner-canary";
import { OneShotTransport, buildAlRunnerArgv, qualifiedTestName } from "./al-runner-transport";
import {
  AL_RUNNER_PREDEFINED_SYMBOLS_V2_12_0,
  type AlRunnerPredefinedProbe,
} from "./preprocessor-symbols";
import { type SpawnFn, defaultSpawn } from "./publisher";

/**
 * R392: measure which preprocessor symbols al-runner PREDEFINES, once per session, instead of
 * assuming the list R377 measured on v2.12.0.
 *
 * The method is R377's (`H:/lethal-scratch/R-214/cleanschema/`): a two-app project whose target
 * codeunit's `Mask()` has one `#if c` / `#else` block per candidate `c`, appending `+c` or `-c`. The
 * test raises `Error('R392MASK:' + Mask() + ':END')`, and the failure message is the answer. It runs
 * as ONE one-shot al-runner process with no `--define`, through the same `OneShotTransport` the
 * canary uses.
 *
 * Two control arms make the answer checkable: `+ALWAYS` sits under a symbol the file `#define`s
 * itself (so it proves the arms were evaluated at all), and `+NEVER` under a symbol nothing defines.
 * An answer is accepted only when it is COMPLETE: one result, for the probe test, failed, carrying
 * exactly one mask, in which every candidate appears exactly once, `+ALWAYS` is present and `NEVER`
 * is absent. Anything else throws `AlRunnerPredefinedProbeError`: a partial answer would record a
 * shrunken set as the build's identity.
 *
 * THE LIMIT: the probe sees only its candidates. A predefined symbol outside CLEANSCHEMA1..40 and
 * CLEANSCHEMA goes unseen (R392 records it).
 */

export const AL_RUNNER_PREDEFINED_CANDIDATES: readonly string[] = [
  ...Array.from({ length: 40 }, (_, i) => `CLEANSCHEMA${i + 1}`),
  "CLEANSCHEMA",
];

const PROBE_TARGET_APP_ID = "5b0e7c1d-3a92-4f6e-8d41-c2a7e9b0f392";
const PROBE_TESTS_APP_ID = "8e4f2a6b-9c13-4d7a-b5e0-1f3c6a8d2392";
const PROBE_MASK_CODEUNIT_ID = 50100;
const PROBE_TESTS_CODEUNIT_ID = 50101;
const PROBE_METHOD = "ProbeMask";
// Defined by the generated file itself, so the arm is in on every compiler that evaluates arms.
const ALWAYS_SYMBOL = "LETHALR392ALWAYS";
// Defined by nothing: alc and al-runner have no reason to.
const NEVER_SYMBOL = "LETHALR392NEVER";

/** The qualified name the probe sends as `--test` and reads back (`Codeunit50101.ProbeMask`). */
export const AL_RUNNER_PREDEFINED_PROBE_TEST = qualifiedTestName(
  PROBE_TESTS_CODEUNIT_ID,
  PROBE_METHOD,
);

export function probeMaskCodeunitAl(): string {
  const arms = AL_RUNNER_PREDEFINED_CANDIDATES.map(
    (c) => `#if ${c}\n        R += '+${c} ';\n#else\n        R += '-${c} ';\n#endif`,
  ).join("\n");
  return `#define ${ALWAYS_SYMBOL}
codeunit ${PROBE_MASK_CODEUNIT_ID} "LethAL R392 Mask"
{
    procedure Mask(): Text
    var
        R: Text;
    begin
#if ${ALWAYS_SYMBOL}
        R += '+ALWAYS ';
#endif
#if ${NEVER_SYMBOL}
        R += '+NEVER ';
#endif
${arms}
        exit(R);
    end;
}
`;
}

const PROBE_TESTS_AL = `codeunit ${PROBE_TESTS_CODEUNIT_ID} "LethAL R392 Probe"
{
    Subtype = Test;

    [Test]
    procedure ${PROBE_METHOD}()
    var
        MaskCodeunit: Codeunit "LethAL R392 Mask";
    begin
        Error('R392MASK:' + MaskCodeunit.Mask() + ':END');
    end;
}
`;

/** Writes the probe project under `root`; exported so the generated AL can be compiled offline. */
export async function writePredefinedProbeProject(
  root: string,
): Promise<{ sourceDir: string; testDir: string }> {
  // Two physically distinct directories: al-runner double-loads one passed as both (see the canary).
  const sourceDir = join(root, "src");
  const testDir = join(root, "tests");
  await mkdir(sourceDir, { recursive: true });
  await mkdir(testDir, { recursive: true });
  const targetName = "LethAL R392 Probe Target";
  await writeFile(
    join(sourceDir, "app.json"),
    baseAppJson({
      id: PROBE_TARGET_APP_ID,
      name: targetName,
      idFrom: PROBE_MASK_CODEUNIT_ID,
      idTo: PROBE_MASK_CODEUNIT_ID,
    }),
    "utf8",
  );
  await writeFile(join(sourceDir, "R392Mask.Codeunit.al"), probeMaskCodeunitAl(), "utf8");
  await writeFile(
    join(testDir, "app.json"),
    baseAppJson({
      id: PROBE_TESTS_APP_ID,
      name: "LethAL R392 Probe Tests",
      idFrom: PROBE_TESTS_CODEUNIT_ID,
      idTo: PROBE_TESTS_CODEUNIT_ID,
      dependencies: [
        { id: PROBE_TARGET_APP_ID, name: targetName, publisher: "LethAL", version: "1.0.0.0" },
      ],
    }),
    "utf8",
  );
  await writeFile(join(testDir, "R392Probe.Codeunit.al"), PROBE_TESTS_AL, "utf8");
  return { sourceDir, testDir };
}

/** The probe could not give a complete answer, so the run's symbol set is unknown. */
export class AlRunnerPredefinedProbeError extends Error {
  constructor(
    readonly reason: string,
    readonly outputTail: string,
  ) {
    super(
      `R392: could not measure al-runner's predefined preprocessor symbols: ${reason}. Refusing to run: the arms this build compiles, and the build identity the run records, would be a guess. al-runner said: ${outputTail}`,
    );
    this.name = "AlRunnerPredefinedProbeError";
  }
}

const TAIL_CHARS = 2000;
const tail = (s: string): string => (s.length > TAIL_CHARS ? `...${s.slice(-TAIL_CHARS)}` : s);

/** Strict reader of the probe test's failure message. Throws on anything incomplete. */
function readMask(message: string, output: string): readonly string[] {
  const refuse = (reason: string) => new AlRunnerPredefinedProbeError(reason, output);
  // A second, unterminated `R392MASK:` inside the one match is caught below as an unknown token.
  const masks = [...message.matchAll(/R392MASK:([\s\S]*?):END/g)];
  const body = masks[0]?.[1];
  if (masks.length !== 1 || body === undefined) {
    throw refuse(
      `expected exactly one R392MASK:...:END in the failure message, found ${masks.length}`,
    );
  }
  const known = new Set([...AL_RUNNER_PREDEFINED_CANDIDATES, "ALWAYS"]);
  const seen = new Map<string, boolean>();
  for (const token of body.split(/\s+/).filter((t) => t !== "")) {
    const m = /^([+-])(.+)$/.exec(token);
    const id = m?.[2];
    if (id === "NEVER") throw refuse("the never-defined NEVER arm compiled in");
    if (m === null || id === undefined || !known.has(id)) {
      throw refuse(`unknown token "${token}"`);
    }
    if (seen.has(id)) throw refuse(`"${id}" appears more than once`);
    seen.set(id, m[1] === "+");
  }
  if (seen.get("ALWAYS") !== true) throw refuse("the always-defined +ALWAYS arm is missing");
  const missing = AL_RUNNER_PREDEFINED_CANDIDATES.filter((c) => !seen.has(c));
  if (missing.length > 0) {
    throw refuse(`candidate(s) missing from the mask: ${missing.join(", ")}`);
  }
  return AL_RUNNER_PREDEFINED_CANDIDATES.filter((c) => seen.get(c) === true).sort();
}

const PROBE_TEST_TIMEOUT_SECONDS = 60;
// Generous: without a pin (a dry run) al-runner may provision artifacts inside this call.
const PROBE_DEADLINE_MS = 30 * 60 * 1000;

/** The probe's request (before the timeout fields): the ONE place its argv inputs are decided. */
export function predefinedProbeRequest(
  sourceDir: string,
  testDir: string,
  platformAppsDir?: string,
): Parameters<typeof buildAlRunnerArgv>[1] {
  return {
    sourceDir,
    testDir,
    qualifiedTest: AL_RUNNER_PREDEFINED_PROBE_TEST,
    ...(platformAppsDir !== undefined ? { platformAppsDir } : {}),
  };
}

/** The exact argv the probe spawns. The probe and the gate's allow-list both come through here. */
export function predefinedProbeArgv(
  alRunnerPath: string,
  sourceDir: string,
  testDir: string,
  platformAppsDir?: string,
): string[] {
  return buildAlRunnerArgv(
    alRunnerPath,
    predefinedProbeRequest(sourceDir, testDir, platformAppsDir),
  );
}

/**
 * True when `argv` is EXACTLY what the probe spawns. The scratch directories are random, so they are
 * read back out of the argv (and must be `<tmp>/lethal-r392-probe-*\/src` and `\/tests`), then the
 * whole argv is rebuilt with `predefinedProbeArgv` and compared element for element.
 */
export function isPredefinedProbeArgv(argv: readonly string[], alRunnerPath: string): boolean {
  const t = argv.indexOf("--test");
  if (t < 0 || argv[t + 1] !== AL_RUNNER_PREDEFINED_PROBE_TEST) return false;
  const first = t + 2 + (argv[t + 2] === "--auto-provision" ? 1 : 0);
  const src = argv[first];
  const tests = argv[first + 1];
  if (src === undefined || tests === undefined) return false;
  const root = dirname(src);
  if (
    basename(src) !== "src" ||
    basename(tests) !== "tests" ||
    dirname(tests) !== root ||
    !basename(root).startsWith("lethal-r392-probe-")
  ) {
    return false;
  }
  const pin = argv[argv.indexOf("--package-cache") + 1];
  const want = predefinedProbeArgv(
    alRunnerPath,
    src,
    tests,
    argv.includes("--package-cache") ? pin : undefined,
  );
  return want.length === argv.length && want.every((x, i) => x === argv[i]);
}

export async function probeAlRunnerPredefinedSymbols(
  alRunnerPath: string,
  opts: {
    readonly spawn?: SpawnFn;
    /** The session's R147 pin, so the probe does not pay `--auto-provision` again. */
    readonly platformAppsDir?: string;
    readonly fsOps?: AlRunnerCanaryFsOps;
  } = {},
): Promise<AlRunnerPredefinedProbe> {
  const fsOps = opts.fsOps ?? defaultFsOps;
  const root = await fsOps.mkdtemp(join(tmpdir(), "lethal-r392-probe-"));
  try {
    const { sourceDir, testDir } = await writePredefinedProbeProject(root);
    const transport = new OneShotTransport(alRunnerPath, opts.spawn ?? defaultSpawn);
    let res: Awaited<ReturnType<OneShotTransport["send"]>>;
    try {
      res = await transport.send({
        ...predefinedProbeRequest(sourceDir, testDir, opts.platformAppsDir),
        testTimeoutSeconds: PROBE_TEST_TIMEOUT_SECONDS,
        deadlineMs: PROBE_DEADLINE_MS,
      });
    } finally {
      await transport.close();
    }
    if (res.kind === "deadline") {
      throw new AlRunnerPredefinedProbeError(
        `the probe did not finish within ${PROBE_DEADLINE_MS} ms`,
        "",
      );
    }
    if (res.kind === "error") {
      throw new AlRunnerPredefinedProbeError("the probe run failed", tail(res.detail));
    }
    const output = tail(JSON.stringify(res.tests));
    if (res.tests.length !== 1) {
      throw new AlRunnerPredefinedProbeError(
        `expected exactly one result, got ${res.tests.length}`,
        output,
      );
    }
    const [t] = res.tests;
    if (t === undefined || t.name !== AL_RUNNER_PREDEFINED_PROBE_TEST) {
      throw new AlRunnerPredefinedProbeError(
        `the result is for "${t?.name}", not ${AL_RUNNER_PREDEFINED_PROBE_TEST}`,
        output,
      );
    }
    if (t.status !== "fail") {
      throw new AlRunnerPredefinedProbeError(
        `the probe test reported status "${t.status}", expected "fail"`,
        output,
      );
    }
    return { symbols: readMask(t.message ?? "", output) };
  } finally {
    await cleanUpQuietly(root, fsOps, "al-runner predefined-symbol probe (R392)");
  }
}

/** The `al-runner-predefined-symbols-changed` warning text, or `undefined` when the measured set
 *  equals the v2.12.0 list. The measured set is used either way. */
export function predefinedSymbolsChangedWarning(
  probe: AlRunnerPredefinedProbe,
): string | undefined {
  const known = new Set(AL_RUNNER_PREDEFINED_SYMBOLS_V2_12_0);
  const measured = new Set(probe.symbols);
  const added = probe.symbols.filter((s) => !known.has(s));
  const removed = AL_RUNNER_PREDEFINED_SYMBOLS_V2_12_0.filter((s) => !measured.has(s));
  if (added.length === 0 && removed.length === 0) return undefined;
  return `[lethal] al-runner's predefined preprocessor symbols differ from the list measured on v2.12.0: added [${added.join(", ")}], removed [${removed.join(", ")}]. This run uses the MEASURED set [${probe.symbols.join(", ")}] for its arms and build identity (R392).`;
}
