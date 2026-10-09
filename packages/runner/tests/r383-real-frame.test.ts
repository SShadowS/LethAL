import { describe, expect, spyOn, test } from "bun:test";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AlRunnerCoverageFrameError,
  type AlRunnerCoverageIndex,
  type CoberturaLine,
  alRunnerCoverageFrom,
  alRunnerCoverageFromServer,
  buildAlRunnerCoverageIndex,
  parseCobertura,
} from "../src/al-runner-coverage";
import type { ServerPerTestCoverage } from "../src/al-runner-server";
import { scratchDirs } from "./helpers/scratch";

/**
 * R383/R407: what the coverage-frame probe separates, on al-runner's REAL output for LethAL's
 * instrumented `MultiPair.Codeunit.al` (two codeunits, `Multi A` on lines 1-24, `Multi B` on 26-76).
 *
 * NEGATIVE evidence, v2.12.0-main.c39ad5de (`cobertura-reached-both-ways.xml`,
 * `server-reached-both-ways.json`, `cobertura-calls-never.xml`, `server-calls-never.json`): al-runner
 * found the source project with the same app id, labelled coverage with the SOURCE path, and
 * reported every `Multi B` line 24 - 7 = 17 lines early ((A's end in the SOURCE) + (distance in the
 * INSTRUMENTED text)); three of them land inside `Multi A.Never`. Through an admitted index the
 * source label now STOPS the session (`AlRunnerCoverageFrameError`), and had the label been right
 * the lines would still mis-attribute, which is why the probe checks lines as well as labels.
 *
 * POSITIVE evidence, v2.12.0-main.43f76177 (`cobertura-43f76177-*.xml`, `server-43f76177.json`,
 * R-407 step 1): the same layout, the same bundle byte for byte, every object in the instrumented
 * frame, labelled inside the bundle, so every hit resolves to its true owner.
 *
 * The bundle is laid out as it was measured: `<root>/inst/active/MultiPair.Codeunit.al`, with the
 * one-shot labels relative to `<root>` (al-runner's cwd) and the server's absolute.
 */

const DIR = join(import.meta.dir, "fixtures", "r383-real-frame");
const PAIR = "MultiPair.Codeunit.al";
const A = 79800;
const B = 79801;
const scratch = scratchDirs();

/** The measured layout, and an admitted index over its bundle. */
async function layout(): Promise<{ root: string; index: AlRunnerCoverageIndex }> {
  const root = scratch("lethal-r407-real-frame-");
  const bundle = join(root, "inst", "active");
  await mkdir(bundle, { recursive: true });
  await copyFile(join(DIR, PAIR), join(bundle, PAIR));
  const index = await buildAlRunnerCoverageIndex(bundle, {
    admitMultiObjectFiles: true,
    labelBase: root,
  });
  return { root, index };
}
const cobertura = async (name: string) => parseCobertura(await readFile(join(DIR, name), "utf8"));
const hitLines = async (name: string) =>
  (await cobertura(name)).filter((l) => l.hits > 0).map((l) => l.line);
const show = (entries: readonly { objectId: number; procedure?: string; line?: number }[]) =>
  entries.map((e) => `${e.objectId} ${e.procedure ?? "-"} ${e.line ?? "-"}`);
const serverOf = async (name: string) =>
  JSON.parse(await readFile(join(DIR, name), "utf8")) as ServerPerTestCoverage;
/** The 43f76177 daemon payload for one test, its `<scratch>/work` prefix re-rooted at `root`. */
async function server43(test: string, root: string): Promise<ServerPerTestCoverage> {
  const all = JSON.parse(await readFile(join(DIR, "server-43f76177.json"), "utf8")) as {
    perTestCoverage: ServerPerTestCoverage[];
  };
  const entry = all.perTestCoverage.find((p) => p.test === test);
  if (entry === undefined) throw new Error(`no 43f76177 server entry for ${test}`);
  return {
    ...entry,
    coverage: (entry.coverage ?? []).map((f) => ({
      ...f,
      file: f.file.replace("<scratch>/work", root),
    })),
  };
}
/** A c39ad5de row relabelled into the bundle: "what if only the label had been fixed". */
const intoBundle = (rows: readonly CoberturaLine[]) =>
  rows.map((r) => ({ ...r, file: `inst/active/${PAIR}` }));

describe("R383/R407: c39ad5de's real frame (negative evidence)", () => {
  test("the formula: B's hit lines are the instrumented ones shifted 17 up, A's own lines are not moved", async () => {
    const real = await cobertura("cobertura-reached-both-ways.xml");
    const fresh = await cobertura("cobertura-fresh-app-id.xml");
    const freshHits = fresh.filter((l) => l.hits > 0).map((l) => l.line);
    // Instrumented 33/35/40/45/50 (the Active checks) and 57/58/59 (the real arm), all in B.
    expect(freshHits).toEqual([33, 35, 40, 45, 50, 57, 58, 59]);
    expect(await hitLines("cobertura-reached-both-ways.xml")).toEqual(freshHits.map((n) => n - 17));
    // The first object is in the right frame: every A line the control reports, the real run
    // reports too (A is never called, so all of them have 0 hits in the control).
    const realLines = new Set(real.map((l) => l.line));
    for (const l of fresh.filter((x) => x.line <= 24)) expect(realLines.has(l.line)).toBe(true);
  });

  test("R407: the SOURCE label stops the session, on both transports and for both tests", async () => {
    const { index } = await layout();
    for (const name of ["cobertura-reached-both-ways.xml", "cobertura-calls-never.xml"]) {
      const rows = await cobertura(name);
      expect(rows[0]?.file).toBe(`fixtures/sandbox-multiobject/src/${PAIR}`);
      expect(() => alRunnerCoverageFrom(rows, index)).toThrow(AlRunnerCoverageFrameError);
    }
    for (const name of ["server-reached-both-ways.json", "server-calls-never.json"]) {
      const payload = await serverOf(name);
      expect(() => alRunnerCoverageFromServer(payload, index)).toThrow(
        `as "fixtures/sandbox-multiobject/src/${PAIR}", which is outside the bundle`,
      );
    }
  });

  test("had only the label been right, Cobertura would credit B.Reached's lines 16, 18 and 23 to Multi A.Never", async () => {
    const { index } = await layout();
    const map = alRunnerCoverageFrom(
      intoBundle(await cobertura("cobertura-reached-both-ways.xml")),
      index,
    );
    expect(show(map.entries)).toEqual(REAL_RESOLVED);
    expect(map.entries.filter((e) => e.objectId === A).map((e) => [e.procedure, e.line])).toEqual([
      ["Never", 16],
      ["Never", 18],
      ["Never", 23],
    ]);
  });

  test("had only the label been right, --server would still stop: scope Reached at a line inside Never", async () => {
    const { root, index } = await layout();
    const payload = await serverOf("server-reached-both-ways.json");
    const relabelled: ServerPerTestCoverage = {
      ...payload,
      coverage: (payload.coverage ?? []).map((f) => ({
        ...f,
        file: join(root, "inst", "active", PAIR),
      })),
    };
    expect(() => alRunnerCoverageFromServer(relabelled, index)).toThrow(
      `${PAIR}:16 "Reached", but that line is inside "Never", in an admitted multi-object file`,
    );
  });

  test("MAPPER test (synthetic, not evidence): a hit placed on A's line 20 resolves to exactly Multi A.Never 20, on both transports", async () => {
    // Line 20 is a real row of the ReachedBothWays capture (hits 0), EDITED to 1 and relabelled
    // into the bundle, and the server statement is invented: this pins the mapper's arithmetic.
    const real = await cobertura("cobertura-reached-both-ways.xml");
    const row = real.find((l) => l.line === 20);
    if (row === undefined) throw new Error("the captured Cobertura lost its line 20 row");
    const { root, index } = await layout();
    const exact = [{ objectType: "Codeunit", objectId: A, procedure: "Never", line: 20 }];
    expect(alRunnerCoverageFrom(intoBundle([{ ...row, hits: 1 }]), index).entries).toEqual(exact);
    const one: ServerPerTestCoverage = {
      test: "Codeunit79850.ReachedBothWays",
      coverage: [
        {
          file: join(root, "inst", "active", PAIR),
          statements: [{ scope: "Never", line: 20, hits: 1 }],
        },
      ],
    };
    expect(alRunnerCoverageFromServer(one, index).entries).toEqual(exact);
  });
});

describe("R407: 43f76177's real frame (positive evidence, the same layout)", () => {
  test("the same-id ReachedBothWays rows equal the c39ad5de fresh-app-id control, row for row", async () => {
    const now = (await cobertura("cobertura-43f76177-reached-both-ways.xml")).map(
      (l) => `${l.line}x${l.hits}`,
    );
    const control = (await cobertura("cobertura-fresh-app-id.xml")).map(
      (l) => `${l.line}x${l.hits}`,
    );
    expect(now).toEqual(control);
  });

  test("ReachedBothWays resolves to Multi B.Reached only, at its true lines, on both transports", async () => {
    const { root, index } = await layout();
    const exact = [9, 11, 16, 21, 26, 33, 34, 35].map((line) => `${B} Reached ${line}`);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(
        show(
          alRunnerCoverageFrom(await cobertura("cobertura-43f76177-reached-both-ways.xml"), index)
            .entries,
        ),
      ).toEqual(exact);
      const server = await server43("Codeunit79850.ReachedBothWays", root);
      expect(show(alRunnerCoverageFromServer(server, index).entries)).toEqual(exact);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test("CallsNever resolves to Multi A.Never only, at 8, 10, 14 and 20, on both transports", async () => {
    const { root, index } = await layout();
    const exact = [8, 10, 14, 20].map((line) => `${A} Never ${line}`);
    expect(await hitLines("cobertura-43f76177-calls-never.xml")).toEqual([8, 10, 14, 20]);
    expect(
      show(
        alRunnerCoverageFrom(await cobertura("cobertura-43f76177-calls-never.xml"), index).entries,
      ),
    ).toEqual(exact);
    const server = await server43("Codeunit79850.CallsNever", root);
    expect(show(alRunnerCoverageFromServer(server, index).entries)).toEqual(exact);
  });
});

/**
 * `<objectId> <procedure> <object line>` for each c39ad5de hit line, checked by hand against the
 * instrumented file. 16, 18 and 23 are inside `Never` (lines 6-23), so they become A's. 28 is
 * B's `var` header line (object line 4); 33, 40, 41 and 42 are inside `Reached` but at the WRONG
 * lines (B's base is 25: object lines 9, 16, 17, 18, where the true ones are 9, 11, 16, 21, 26,
 * 33, 34, 35).
 */
const REAL_RESOLVED = [
  "79800 Never 16",
  "79800 Never 18",
  "79800 Never 23",
  "79801 - 4",
  "79801 Reached 9",
  "79801 Reached 16",
  "79801 Reached 17",
  "79801 Reached 18",
];
