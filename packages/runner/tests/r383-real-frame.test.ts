import { describe, expect, spyOn, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  alRunnerCoverageFrom,
  alRunnerCoverageFromServer,
  buildAlRunnerCoverageIndex,
  parseCobertura,
} from "../src/al-runner-coverage";
import type { ServerPerTestCoverage } from "../src/al-runner-server";

/**
 * R383: the EVIDENCE that the multi-object refusal is needed, from al-runner's real output.
 *
 * `fixtures/r383-real-frame/` holds LethAL's instrumented `MultiPair.Codeunit.al` (two codeunits,
 * `Multi A` on lines 1-24, `Multi B` on 26-76) and what al-runner v2.12.0-main.c39ad5de reported
 * for the baseline run of `Multi Tests.ReachedBothWays`, which calls only `Multi B.Reached`. The
 * source fixture's `Multi A` ends at line 7, so every `Multi B` line comes back 24 - 7 = 17 lines
 * early: (A's end in the SOURCE) + (distance in the INSTRUMENTED text). Three of them land inside
 * `Multi A.Never`. The control is the same bundle under a fresh app id, where al-runner finds no
 * source project and reports the instrumented frame.
 *
 * The index is built with `admitMultiObjectFiles`, i.e. as the R383 admission would have run.
 * Production refuses the file instead; this file is why.
 */

const DIR = join(import.meta.dir, "fixtures", "r383-real-frame");
const A = 79800;
const B = 79801;

const admittedIndex = () => buildAlRunnerCoverageIndex(DIR, { admitMultiObjectFiles: true });
const cobertura = async (name: string) => parseCobertura(await readFile(join(DIR, name), "utf8"));
const hitLines = async (name: string) =>
  (await cobertura(name)).filter((l) => l.hits > 0).map((l) => l.line);
const show = (entries: readonly { objectId: number; procedure?: string; line?: number }[]) =>
  entries.map((e) => `${e.objectId} ${e.procedure ?? "-"} ${e.line ?? "-"}`);

describe("R383: al-runner's real frame mis-resolves every object after a file's first", () => {
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

  test("Cobertura: B.Reached's lines 16, 18 and 23 are attributed to Multi A.Never", async () => {
    const map = alRunnerCoverageFrom(
      await cobertura("cobertura-reached-both-ways.xml"),
      await admittedIndex(),
    );
    expect(show(map.entries)).toEqual(REAL_RESOLVED);
    expect(map.entries.filter((e) => e.objectId === A).map((e) => [e.procedure, e.line])).toEqual([
      ["Never", 16],
      ["Never", 18],
      ["Never", 23],
    ]);
  });

  test("--server: the same three statements land in Multi A.Never, overruling scope Reached", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const payload = JSON.parse(
        await readFile(join(DIR, "server-reached-both-ways.json"), "utf8"),
      ) as ServerPerTestCoverage;
      const map = alRunnerCoverageFromServer(payload, await admittedIndex());
      expect(show(map.entries)).toEqual(REAL_RESOLVED_SERVER);
      expect(map.entries.filter((e) => e.objectId === A).map((e) => [e.procedure, e.line])).toEqual(
        [
          ["Never", 16],
          ["Never", 18],
          ["Never", 23],
        ],
      );
      // The daemon's own scope says Reached for all three; position overruled it, once each.
      expect(warn.mock.calls.length).toBe(3);
    } finally {
      warn.mockRestore();
    }
  });

  test("positive control: a hit on A's own line 20 (`exit(X + 7)`) resolves to exactly Multi A.Never 20, on both transports", async () => {
    // Line 20 is a real row of the captured run (hits 0: no test calls A). Given a hit, it must
    // land on A at object line 20 (A is first, base 1), not merely somewhere in a set of lines.
    const real = await cobertura("cobertura-reached-both-ways.xml");
    const row = real.find((l) => l.line === 20);
    if (row === undefined) throw new Error("the captured Cobertura lost its line 20 row");
    const index = await admittedIndex();
    const exact = [{ objectType: "Codeunit", objectId: A, procedure: "Never", line: 20 }];
    expect(alRunnerCoverageFrom([{ ...row, hits: 1 }], index).entries).toEqual(exact);
    const payload = JSON.parse(
      await readFile(join(DIR, "server-reached-both-ways.json"), "utf8"),
    ) as ServerPerTestCoverage;
    const [file] = payload.coverage ?? [];
    if (file === undefined) throw new Error("the captured --server payload lost its file");
    const one: ServerPerTestCoverage = {
      ...payload,
      coverage: [{ ...file, statements: [{ scope: "Never", line: 20, hits: 1 }] }],
    };
    expect(alRunnerCoverageFromServer(one, index).entries).toEqual(exact);
  });

  test("control: in the instrumented frame (fresh app id) every hit resolves to Multi B.Reached", async () => {
    const map = alRunnerCoverageFrom(
      await cobertura("cobertura-fresh-app-id.xml"),
      await admittedIndex(),
    );
    expect(map.entries.filter((e) => e.objectId === A)).toEqual([]);
    expect(new Set(map.entries.map((e) => `${e.objectId} ${e.procedure}`))).toEqual(
      new Set([`${B} Reached`]),
    );
  });
});

/**
 * `<objectId> <procedure> <object line>` for each hit line, checked by hand against the
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
/** The same, except the header line keeps the daemon's scope (lookup names nothing there). */
const REAL_RESOLVED_SERVER = REAL_RESOLVED.map((e) => (e === "79801 - 4" ? "79801 Reached 4" : e));
