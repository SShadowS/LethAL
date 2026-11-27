import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionReport } from "../packages/runner/src/report";
import { baselineRefusals, costOf, familyOf, render, unmappedTexts } from "./v3-refusal-cost";

// PR-492: synthetic reports and refusal texts, invented names.
type M = {
  line: number;
  verdict: string;
  killingTest?: string;
  coveringTests?: string[];
  failureNote?: string;
};
const report = (ms: M[]) =>
  ({
    mutants: ms.map((m) => ({
      mutantCode: `M${m.line}`,
      file: "src/A.al",
      line: m.line,
      operatorName: "op",
      startIndex: m.line,
      endIndex: m.line + 1,
      ...m,
    })),
  }) as unknown as SessionReport;
const SEQ =
  "NotRun: out-of-scope: an earlier test of this codeunit, X, changed number sequence 'S' that existed before it";
const REL =
  "NotRun: out-of-scope: the value of field 'RelationFieldNo' of platform table 'Field' is not known";

// Red: put the broad untouched-handle pattern before the narrower FieldRef.SetFilter one.
test("the narrower family wins, a known family needs no NotRun marker, and a plain failure is no refusal", () => {
  expect(
    familyOf("NotRun: out-of-scope: FieldRef.SetFilter on a FieldRef that was never assigned"),
  ).toBe("fieldref-unassigned-setfilter");
  expect(familyOf("part of its reach is not known (runs page N)")).toBe("reach-cascade");
  expect(familyOf("Assert.AreEqual failed. Expected 1")).toBeNull();
  expect(familyOf("NotRun: out-of-scope: something no family names 42")).toBe(
    "unmapped:NotRun: out-of-scope: something no family names N",
  );
});

// Red: count a kill as lost even when v3 still killed the mutant (another test).
test("a BC kill is lost only when v3 did not kill it; refused-only reach counts per family", () => {
  const refused = new Map([
    ["T.Seq", SEQ],
    ["T.Rel", REL],
  ]);
  const bc = report([
    { line: 1, verdict: "killed", killingTest: "Seq", coveringTests: ["T.Seq", "T.Ok"] },
    { line: 2, verdict: "killed", killingTest: "Seq", coveringTests: ["T.Seq", "T.Ok"] },
    { line: 3, verdict: "survived", coveringTests: ["T.Seq", "T.Rel"] },
  ]);
  const v3 = report([
    { line: 1, verdict: "survived" },
    { line: 2, verdict: "killed", killingTest: "Ok" },
    { line: 3, verdict: "error", failureNote: REL },
  ]);
  const c = costOf("run", v3, refused, [bc]);
  expect(c.joined).toBe(3);
  expect(c.families["number-sequence"]).toEqual({
    testsRefused: 1,
    errorMutants: 0,
    killsLost: 1,
    reachedOnlyByRefused: 1,
  });
  expect(c.families.relationfieldno).toEqual({
    testsRefused: 1,
    errorMutants: 1,
    killsLost: 0,
    reachedOnlyByRefused: 1,
  });
});

// Red: print the unmapped text itself in the shared file.
test("the shared file withholds unmapped texts; the private list numbers them the same way", () => {
  const v3 = report([
    {
      line: 1,
      verdict: "error",
      failureNote: "NotRun: out-of-scope: table Secret Name does a thing",
    },
  ]);
  const c = costOf("run", v3, new Map());
  const md = render([c]);
  expect(md).toContain("unmapped text U1 (withheld");
  expect(md).not.toContain("Secret Name");
  expect(unmappedTexts([c])).toEqual([
    "U1\tNotRun: out-of-scope: table <x>Secret Name does a thing".replace("<x>", ""),
  ]);
});

test("the ranking sums kills lost and error mutants over the runs", () => {
  const a = costOf("a", report([{ line: 1, verdict: "error", failureNote: REL }]), new Map());
  const b = costOf("b", report([{ line: 1, verdict: "survived" }]), new Map([["T.Seq", SEQ]]), [
    report([{ line: 1, verdict: "killed", killingTest: "Seq", coveringTests: ["T.Seq"] }]),
  ]);
  const md = render([a, b]);
  expect(md.indexOf("#8592")).toBeGreaterThan(0);
  // each family scores 1; the tie breaks by tests refused (number-sequence 1, RelationFieldNo 0)
  expect(md.indexOf("#8002")).toBeLessThan(md.indexOf("#8592"));
});

// Red: read every run, or keep a nameless row.
test("the store reader takes the latest run's non-pass baseline rows with their messages", () => {
  const dir = mkdtempSync(join(tmpdir(), "v3-refusal-cost-"));
  try {
    const path = join(dir, "store.sqlite");
    const db = new Database(path);
    db.run(
      "create table test_results (run_id integer, mutant_row_id integer, codeunit_name text, method text, outcome text, failure_message text)",
    );
    db.run("insert into test_results values (1, null, 'Old', 'Gone', 'fail', 'x')");
    db.run("insert into test_results values (2, null, 'A. B.', 'Red', 'notRun', ?)", [SEQ]);
    db.run("insert into test_results values (2, null, 'A. B.', 'Green', 'pass', null)");
    db.close();
    expect([...baselineRefusals(path)]).toEqual([["A. B..Red", SEQ]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
