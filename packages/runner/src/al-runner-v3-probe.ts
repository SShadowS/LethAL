/**
 * R586 §8 `predefined-symbols`: measure which preprocessor symbols al-runner v3 PREDEFINES, every
 * session, the way R392 does for v2. LethAL's alc proof (`AlRunnerV3Backend.deploy`) compiles with
 * no predefined symbol, so `runSession` refuses a v3 that predefines any: alc would have proved
 * other `#if` arms than v3 runs. Candidates (Q16): CLEAN, CLEANSCHEMA, CLEANSCHEMA1..40, BC1..40.
 *
 * Method as R392: one target codeunit whose `Mask()` has one `#if c` / `#else` block per candidate,
 * one test raising `Error('R586MASK:' + Mask() + ':END')`, two controls (+ALWAYS under a symbol the
 * file defines, NEVER under none). An answer is accepted only when complete.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { decodeV3Rows } from "./al-runner-v3-backend";
import { type SpawnFn, absToolPath, defaultSpawn } from "./publisher";

/** What the probe MEASURED v3 to predefine: sorted, only `V3_PREDEFINED_CANDIDATES` can appear.
 *  (Was `preprocessor-symbols.ts`' `AlRunnerPredefinedProbe`, shared with the retired v2 probe.) */
export interface V3PredefinedProbe {
  readonly symbols: readonly string[];
}

/** A probe app's `app.json`. Moved here from `al-runner-canary.ts` by R654 S1: the v3 probes use
 *  it. */
export function baseAppJson(overrides: {
  id: string;
  name: string;
  idFrom: number;
  idTo: number;
  dependencies?: readonly { id: string; name: string; publisher: string; version: string }[];
}): string {
  return JSON.stringify(
    {
      id: overrides.id,
      name: overrides.name,
      publisher: "LethAL",
      version: "1.0.0.0",
      brief: "",
      description: "",
      privacyStatement: "",
      EULA: "",
      help: "",
      url: "",
      logo: "",
      dependencies: overrides.dependencies ?? [],
      screenshots: [],
      idRanges: [{ from: overrides.idFrom, to: overrides.idTo }],
      resourceExposurePolicy: {
        allowDebugging: true,
        allowDownloadingSource: true,
        includeSourceInSymbolFile: true,
      },
      runtime: "13.0",
      features: [],
    },
    null,
    2,
  );
}

export const V3_PREDEFINED_CANDIDATES: readonly string[] = [
  "CLEAN",
  "CLEANSCHEMA",
  ...Array.from({ length: 40 }, (_, i) => `CLEANSCHEMA${i + 1}`),
  ...Array.from({ length: 40 }, (_, i) => `BC${i + 1}`),
];

const MASK_ID = 50190;
const TEST_ID = 50191;
const ALWAYS = "LETHALR586ALWAYS";
const NEVER = "LETHALR586NEVER";

function maskAl(): string {
  const arms = V3_PREDEFINED_CANDIDATES.map(
    (c) => `#if ${c}\n        R += '+${c} ';\n#else\n        R += '-${c} ';\n#endif`,
  ).join("\n");
  return `#define ${ALWAYS}
codeunit ${MASK_ID} "LethAL R586 Mask"
{
    procedure Mask(): Text
    var
        R: Text;
    begin
#if ${ALWAYS}
        R += '+ALWAYS ';
#endif
#if ${NEVER}
        R += '+NEVER ';
#endif
${arms}
        exit(R);
    end;
}
`;
}

const TEST_AL = `codeunit ${TEST_ID} "LethAL R586 Mask Probe"
{
    Subtype = Test;

    [Test]
    procedure ProbeMask()
    var
        M: Codeunit "LethAL R586 Mask";
    begin
        Error('R586MASK:' + M.Mask() + ':END');
    end;
}
`;

/** The probe could not give a complete answer. Extends `Error` directly. */
export class AlRunnerV3ProbeError extends Error {
  constructor(reason: string) {
    super(`R586: could not measure al-runner v3's predefined preprocessor symbols: ${reason}`);
    this.name = "AlRunnerV3ProbeError";
  }
}

/** Strict reader of the mask: every candidate once, +ALWAYS present, NEVER absent. */
export function readV3Mask(message: string): readonly string[] {
  const masks = [...message.matchAll(/R586MASK:([\s\S]*?):END/g)];
  const body = masks[0]?.[1];
  if (masks.length !== 1 || message.split("R586MASK:").length !== 2 || body === undefined) {
    throw new AlRunnerV3ProbeError(
      `expected exactly one R586MASK:...:END, got: ${message.slice(0, 300)}`,
    );
  }
  const known = new Set([...V3_PREDEFINED_CANDIDATES, "ALWAYS"]);
  const seen = new Map<string, boolean>();
  for (const token of body.split(/\s+/).filter((t) => t !== "")) {
    const m = /^([+-])(.+)$/.exec(token);
    const id = m?.[2];
    if (id === "NEVER") throw new AlRunnerV3ProbeError("the never-defined NEVER arm compiled in");
    if (m === null || id === undefined || !known.has(id) || seen.has(id)) {
      throw new AlRunnerV3ProbeError(`unknown or repeated token "${token}"`);
    }
    seen.set(id, m[1] === "+");
  }
  if (seen.get("ALWAYS") !== true) throw new AlRunnerV3ProbeError("the +ALWAYS control is missing");
  const missing = V3_PREDEFINED_CANDIDATES.filter((c) => !seen.has(c));
  if (missing.length > 0)
    throw new AlRunnerV3ProbeError(`candidates missing: ${missing.join(", ")}`);
  return V3_PREDEFINED_CANDIDATES.filter((c) => seen.get(c) === true).sort();
}

/** One v3 call on a generated two-app project, with the session's package cache and build. */
export async function probeV3PredefinedSymbols(a: {
  readonly alRunnerPath: string;
  readonly packagesDir: string;
  readonly bcVersion: string;
  readonly cacheDir?: string;
  readonly spawn?: SpawnFn;
}): Promise<V3PredefinedProbe> {
  const root = await mkdtemp(join(tmpdir(), "lethal-r586-predefined-"));
  try {
    const src = join(root, "src");
    const tests = join(root, "tests");
    await mkdir(src, { recursive: true });
    await mkdir(tests, { recursive: true });
    const targetId = "6a0c3e1d-5b86-4f2e-9d17-c0b2a8e5f586";
    await writeFile(
      join(src, "app.json"),
      baseAppJson({ id: targetId, name: "LethAL R586 Mask", idFrom: MASK_ID, idTo: MASK_ID }),
    );
    await writeFile(join(src, "Mask.Codeunit.al"), maskAl());
    await writeFile(
      join(tests, "app.json"),
      baseAppJson({
        id: "7b1d4f2e-6c97-4a3f-8e28-d1c3b9f6a586",
        name: "LethAL R586 Mask Probe",
        idFrom: TEST_ID,
        idTo: TEST_ID,
        dependencies: [
          { id: targetId, name: "LethAL R586 Mask", publisher: "LethAL", version: "1.0.0.0" },
        ],
      }),
    );
    await writeFile(join(tests, "MaskProbe.Codeunit.al"), TEST_AL);
    // R645: run in `root` (v3 writes coverage.cobertura.xml into its cwd), so paths are absolute.
    const res = await (a.spawn ?? defaultSpawn)(
      [
        absToolPath(a.alRunnerPath),
        "test",
        "--output-json",
        "--isolation",
        "test",
        "--codeunit",
        String(TEST_ID),
        "--package-cache",
        resolve(a.packagesDir),
        "--bc-version",
        a.bcVersion,
        "--no-download",
        src,
        tests,
      ],
      {
        cwd: root,
        ...(a.cacheDir !== undefined ? { env: { ALRUNNER_CACHE: resolve(a.cacheDir) } } : {}),
      },
    );
    if (res.exitCode !== 1) {
      throw new AlRunnerV3ProbeError(
        `v3 exited ${res.exitCode}, expected 1 (the probe test fails). stderr: ${res.stderr.slice(-400)}`,
      );
    }
    const decoded = decodeV3Rows(res.stdout, TEST_ID);
    if ("why" in decoded) throw new AlRunnerV3ProbeError(decoded.why);
    const [row, ...rest] = decoded.rows;
    if (row === undefined || rest.length > 0 || row.status !== "fail" || row.notRun) {
      throw new AlRunnerV3ProbeError(
        `expected one failing row, got ${JSON.stringify(decoded.rows).slice(0, 300)}`,
      );
    }
    return { symbols: readV3Mask(row.message ?? "") };
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}
