import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeInstrumentedProject } from "@lethal/schemata";
import {
  EXPECTED_MULTIOBJECT,
  type MultiObjectRow,
  assertMultiObjectRefusal,
  assertMultiObjectRun,
} from "../itest/multiobject-fixture";
import { alRunnerCoverageFrom, buildAlRunnerCoverageIndex } from "../src/al-runner-coverage";
import { withAlRunnerCoverageGuard } from "../src/cli";
import { lineMapFromSources } from "../src/line-map";
import {
  generateMutationSet,
  identityOrdinalsOf,
  operatorTiers,
  planArtifacts,
  prepareBatchProject,
} from "../src/orchestrator";

/**
 * R383, offline guard for `fixtures/sandbox-multiobject`'s PURPOSE. The live legs in
 * `itest:alrunner` are pre-committed in
 * docs/superpowers/specs/2026-10-02-r383-multiobject-refusal-precommitment.md (the multi-object
 * refusal, coverage "none"), and bcdev's in 2026-10-02-r383-multiobject-precommitment.md. Both rest
 * on the twelve mutants below; the future al-runner admission also rests on each covered line of
 * the EMITTED bundle resolving to its own object and procedure. This re-derives both from the code,
 * so a fixture edit or an emitter change that moves them fails here in seconds, not after a live
 * run.
 */

const PROJECT = resolve(import.meta.dir, "../../../fixtures/sandbox-multiobject");
const PAIR = "MultiPair.Codeunit.al";

/** `<code> <file> <line> <operator> <type:id> <procedure>`, the dry run's twelve rows. */
const EXPECTED_MUTANTS = [
  "M0001 src/MultiControl.Codeunit.al 4 lethal.empty-block codeunit:79802 Double",
  "M0002 src/MultiControl.Codeunit.al 5 lethal.return-value codeunit:79802 Double",
  "M0003 src/MultiPair.Codeunit.al 4 lethal.empty-block codeunit:79800 Never",
  "M0004 src/MultiPair.Codeunit.al 5 lethal.return-value codeunit:79800 Never",
  "M0005 src/MultiPair.Codeunit.al 5 lethal.swap-additive codeunit:79800 Never",
  "M0006 src/MultiPair.Codeunit.al 12 lethal.empty-block codeunit:79801 Reached",
  "M0007 src/MultiPair.Codeunit.al 13 lethal.conditional-boundary codeunit:79801 Reached",
  "M0008 src/MultiPair.Codeunit.al 14 lethal.return-value codeunit:79801 Reached",
  "M0009 src/MultiPair.Codeunit.al 14 lethal.swap-additive codeunit:79801 Reached",
  "M0010 src/MultiPair.Codeunit.al 15 lethal.return-value codeunit:79801 Reached",
  "M0011 src/MultiPair.Codeunit.al 17 lethal.empty-block codeunit:79801 Unreached",
  "M0012 src/MultiPair.Codeunit.al 18 lethal.return-value codeunit:79801 Unreached",
];

interface Built {
  readonly batchPaths: readonly (readonly string[])[];
  readonly rows: readonly string[];
  readonly dir: string;
}

/** Instruments the project as `runSession` does (default batching), into a scratch directory. */
async function build(root: string): Promise<Built> {
  const set = await generateMutationSet(PROJECT);
  const { files } = set;
  const batches = planArtifacts(files, {});
  const manifest = JSON.parse(await readFile(join(PROJECT, "app.json"), "utf8")) as Record<
    string,
    unknown
  >;
  const [only] = batches;
  if (only === undefined || batches.length !== 1) throw new Error("expected one batch");
  const dir = join(root, "batch-0");
  await writeInstrumentedProject({
    targetDir: dir,
    files: only,
    selectorIds: { selectorId: 79849, controlId: 79848, tableId: 79847 },
    artifactId: "0123456789abcdef0123456789abcdef",
    targetAppId: String(manifest.id),
    operatorTiers,
    identityOrdinals: identityOrdinalsOf(set),
  });
  await prepareBatchProject(PROJECT, dir, manifest, "1.0.1.1");
  const written = JSON.parse(await readFile(join(dir, "mutant-manifest.json"), "utf8")) as {
    mutants: {
      mutantId: string;
      file: string;
      startLine: number;
      operatorName: string;
      objectType: string;
      codeunitId: number;
      procedureName: string;
    }[];
  };
  const rows = written.mutants.map(
    (m) =>
      `${m.mutantId} ${m.file} ${m.startLine} ${m.operatorName} ${m.objectType}:${m.codeunitId} ${m.procedureName}`,
  );
  return { batchPaths: batches.map((b) => b.map((f) => f.path)), rows, dir };
}

describe("R383: sandbox-multiobject", () => {
  let root = "";
  let built: Built | undefined;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "lethal-r383-"));
    built = await build(root);
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const get = (): Built => {
    if (built === undefined) throw new Error("beforeAll did not build the batch");
    return built;
  };

  it("gives the pre-committed twelve mutants in one batch", () => {
    // R411/R421: discovered paths are written in one form, `/`, on every platform, so these pins
    // hold everywhere.
    expect(get().batchPaths).toEqual([
      ["src/MultiControl.Codeunit.al", "src/MultiPair.Codeunit.al"],
    ]);
    expect(get().rows).toEqual(EXPECTED_MUTANTS);
  });

  it("the itest leg's pre-committed table names exactly these mutants", () => {
    const sites = EXPECTED_MULTIOBJECT.map(
      (r) => `${r.code} ${r.file} ${r.line} ${r.operatorName} ${r.procedureName}`,
    );
    expect(sites).toEqual(EXPECTED_MUTANTS.map((m) => m.replace(/ codeunit:\d+/, "")));
  });

  it("the emitted pair is NAMED and not indexed by default (the R383 refusal)", async () => {
    const index = await buildAlRunnerCoverageIndex(get().dir);
    expect(index.multiObjectFiles).toEqual([PAIR]);
    expect(index.byFile.has("multipair.codeunit.al")).toBe(false);
    expect(index.byFile.has("multicontrol.codeunit.al")).toBe(true);
    expect(alRunnerCoverageFrom([{ file: PAIR, line: 20, hits: 1 }], index).entries).toEqual([]);
  });

  it("admitted (infrastructure), each baseline line of the emitted pair resolves to its owner", async () => {
    const { dir } = get();
    // R407: the bare label resolves against the bundle, so it names the bundle's own file.
    const index = await buildAlRunnerCoverageIndex(dir, {
      admitMultiObjectFiles: true,
      labelBase: dir,
    });
    expect(index.multiObjectFiles).toEqual([PAIR]);
    const lines = (await readFile(join(dir, PAIR), "utf8")).split(/\r?\n/);
    /** The LAST line holding `needle`: the unmutated `else` arm, which the baseline runs. */
    const last = (needle: string): number => {
      const at = lines.map((l, i) => (l.includes(needle) ? i + 1 : 0)).filter((n) => n > 0);
      const n = at[at.length - 1];
      if (n === undefined) throw new Error(`no emitted line holds ${needle}`);
      return n;
    };
    const owners: [string, string][] = [
      ["exit(X + 7);", "79800 Never"],
      ["exit(X + 1);", "79801 Reached"],
      ["exit(X); end", "79801 Reached"],
      ["exit(X * 3);", "79801 Unreached"],
    ];
    for (const [needle, owner] of owners) {
      const map = alRunnerCoverageFrom([{ file: PAIR, line: last(needle), hits: 1 }], index);
      const got = map.entries.map((e) => `${e.objectId} ${e.procedure ?? "-"}`);
      expect([needle, got]).toEqual([needle, [owner]]);
    }
  });

  it("the real CLI guard refuses the fixture on a build the frame probe refuses: coverage none, one warning naming the pair", async () => {
    const warned: string[] = [];
    const out = await withAlRunnerCoverageGuard(
      { alRunner: { alRunnerPath: "a", coverage: "al-runner" } },
      PROJECT,
      (l) => warned.push(l),
      {
        // R407: the c39ad5de answer; the guard admits only on the probe's say-so.
        frameProbe: async () => ({
          outcome: "refused",
          transport: "server",
          build: undefined,
          refusal: "lines-differ",
          reason: "Probe B was reported hit at lines [33, 34, 35]",
        }),
      },
    );
    expect(() => assertMultiObjectRefusal(out.alRunner?.coverage, warned)).not.toThrow();
    // And the check is not vacuous: coverage left on, or no warning, both fail it.
    expect(() => assertMultiObjectRefusal("al-runner", warned)).toThrow("expected none");
    expect(() => assertMultiObjectRefusal("none", [])).toThrow("expected ONE");
  });

  it("the legs' table check passes the R407 admission table and fails the refusal and wrong-frame rows", () => {
    const report = (rows: readonly MultiObjectRow[], coverageMode = "al-runner") => ({
      coverageMode,
      baselineGreen: true,
      batches: 1,
      mutants: rows.map((r) => ({ ...r, mutantCode: r.code })),
    });
    expect(() => assertMultiObjectRun(report(EXPECTED_MULTIOBJECT), "offline")).not.toThrow();
    expect(() => assertMultiObjectRun(report(EXPECTED_MULTIOBJECT, "none"), "x")).toThrow(
      "coverageMode is none",
    );
    // The R383 refusal (coverage off): every mutant runs both green tests, so A's and Unreached's
    // mutants read survived. It must fail the admission table.
    const both = ["Multi Tests.ControlDoubles", "Multi Tests.ReachedBothWays"];
    const refusalRun = EXPECTED_MULTIOBJECT.map((r) => {
      const { coverageAttribution: _, ...rest } = r;
      return r.verdict === "no-coverage"
        ? { ...rest, verdict: "survived" as const, coveringTests: both }
        : { ...rest, coveringTests: both };
    });
    expect(() => assertMultiObjectRun(report(refusalRun), "refusal")).toThrow(/M0003:.*\n.*M0004/);
    // The c39ad5de wrong frame admitted silently (R383's first live run, itest-record.log): B's
    // lines land in A.Never, so A's mutants gain ReachedBothWays and read survived.
    const wrongFrame = EXPECTED_MULTIOBJECT.map((r) =>
      r.procedureName === "Never"
        ? {
            ...r,
            verdict: "survived" as const,
            coveringTests: ["Multi Tests.ReachedBothWays"],
            coverageAttribution: "exact",
          }
        : r,
    );
    expect(() => assertMultiObjectRun(report(wrongFrame), "wrong frame")).toThrow(
      /M0003:.*\n.*M0004/,
    );
    // R383 r2: a duplicated row fails, though every code still matches its expected row.
    const [first] = EXPECTED_MULTIOBJECT;
    if (first === undefined) throw new Error("EXPECTED_MULTIOBJECT is empty");
    expect(() =>
      assertMultiObjectRun(report([...EXPECTED_MULTIOBJECT, first]), "duplicated"),
    ).toThrow("13 rows, expected 12");
    expect(() =>
      assertMultiObjectRun(report([...EXPECTED_MULTIOBJECT, first]), "duplicated"),
    ).toThrow(`actual repeats code(s) ${first.code}`);
  });

  it("in the source frame, Reached's last statement sits on the line right before Unreached", async () => {
    // The plan's boundary: a base one line off moves this covered statement into Unreached. In the
    // EMITTED text the instrumenter's closing lines sit between them, which the spec states.
    const text = await readFile(join(PROJECT, "src", PAIR), "utf8");
    const m = await lineMapFromSources(
      [{ path: PAIR, text }],
      new Set(["codeunit:79800", "codeunit:79801"]),
    );
    const lines = text.split(/\r?\n/);
    const exitLine = lines.findIndex((l) => l.includes("exit(X); end;")) + 1;
    // A ends at file line 7, so B bases at 8 (the blank line belongs to B): object = file - 7.
    const objectLine = exitLine - 7;
    expect(lines[exitLine]?.trim().startsWith("procedure Unreached(")).toBe(true);
    expect(m.lookup("Codeunit", 79801, objectLine)).toBe("Reached");
    expect(m.lookup("Codeunit", 79801, objectLine + 1)).toBe("Unreached");
  });
});
