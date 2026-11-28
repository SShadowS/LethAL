import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionReport } from "../packages/runner/src/report";
import {
  FAMILIES,
  baselineRefusals,
  costOf,
  familyOf,
  render,
  unmappedTexts,
} from "./v3-refusal-cost";

// PR-499: each NEW cause the BC.History re-sweep put in the refusal ledger is costed under an issue. A cause with a
// specific issue lands in a family (never unmapped, never `testpage`'s "LethAL"), and a PR-499 family it lands in names
// that issue; a cause with only the #7775 umbrella stays unmapped. (An older family keeps its own issue: e.g.
// `untouched-handle` says #7760 where the ledger's BinaryReader rows say #7997; that predates PR-499.)
// Red: drop or reorder a PR-499 family, give one another issue, or map an umbrella-only cause.
const PR499_FAMILIES = new Set([
  "no-client-login-events",
  "no-client-session",
  "current-transaction-type",
  "xrec-table-procedure",
  "geturl-web-service",
  "option-member-list",
  "relation-platform-field",
  "request-page",
  "guarded-run-consistent",
  "worksheet-caption",
  "timezone-policy",
  "dotnet-exception-text",
  "dotnet-null-instance",
  "dotnet-registry-member",
  "dotnet-platform-type",
  "autoformat-type",
  "fieldref-blob-setview",
  "report-layout-file",
  "tenant-permission-delete",
  "permissions-property-read",
  "descending-deleteall",
  "setvalue-text-relation",
]);
test("PR-499: every ledger cause with a specific issue is costed under it; an umbrella-only cause stays unmapped", () => {
  const ledger = JSON.parse(
    readFileSync(
      join(import.meta.dir, "..", "docs", "measurements", "refusal-ledger.json"),
      "utf8",
    ),
  ) as { key: string; state: string; issue?: string; note?: string }[];
  // the causes PR-499 added (its two `fixed` updates carry a "PR-499: gone on ..." note instead)
  const mine = ledger.filter((e) => /^PR-499: \d+ on the BC\.History re-sweep/.test(e.note ?? ""));
  expect(mine.length).toBe(92);
  expect(FAMILIES.filter((f) => PR499_FAMILIES.has(f.id)).length).toBe(PR499_FAMILIES.size);
  const nums = (s: string) => (s.match(/#\d+/g) ?? []).filter((n) => n !== "#7775");
  const wrong = mine.flatMap((e) => {
    const id = familyOf(e.key) ?? "";
    const fam = FAMILIES.find((f) => f.id === id);
    const specific = nums(e.issue ?? "");
    if (specific.length === 0)
      return id.startsWith("unmapped:") ? [] : [`${e.key} -> ${id}, but no specific issue`];
    if (fam === undefined || id === "testpage") return [`${e.key} -> ${id}`];
    if (PR499_FAMILIES.has(id) && !nums(fam.issue).some((n) => specific.includes(n)))
      return [`${e.key} -> ${id} (${fam.issue}) vs ${e.issue}`];
    return [];
  });
  expect(wrong).toEqual([]);
  // The causes an OLDER family costs under an issue the ledger does not give them, pinned (R1248 names them): a new
  // one goes red here instead of hiding an open issue as another one.
  const older = mine.flatMap((e) => {
    const id = familyOf(e.key) ?? "";
    const fam = FAMILIES.find((f) => f.id === id);
    const specific = nums(e.issue ?? "");
    return fam !== undefined &&
      !PR499_FAMILIES.has(id) &&
      specific.length > 0 &&
      !nums(fam.issue).some((n) => specific.includes(n))
      ? [id]
      : [];
  });
  expect(older.sort()).toEqual([
    "unpinned-error-text",
    "untouched-handle",
    "untouched-handle",
    "untouched-handle",
    "zip-archive",
    "zip-archive",
  ]);
});

// PR-499: the families read al-runner's raw text too, not only the ledger's normalised key (numbers as N, names <x>).
test("PR-499: the raw forms of a numbered and a named cause find their family", () => {
  expect(
    familyOf(
      "NotRun: out-of-scope: AutoFormatType 132584 (a type outside the pinned ones; BC resolves it through the AutoFormatTranslate event)",
    ),
  ).toBe("autoformat-type");
  expect(
    familyOf(
      "NotRun: out-of-scope: store error the value of field 'Code' of platform table 'Probe Row' is not known for field 'Ref' of table 'Probe Line', a TableRelation without a field of a shape not measured",
    ),
  ).toBe("relation-platform-field");
  expect(
    familyOf(
      "NotRun: out-of-scope: the login: which login events BC raises in a session without a client (--no-client) is not pinned",
    ),
  ).toBe("no-client-login-events");
});

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
const OUT = "NotRun: out-of-scope: an OutStream was expected, got an untouched handle";

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
  expect(
    familyOf("NotRun: out-of-scope: an earlier test changed IsolatedStorage key 'K' that existed"),
  ).toBe("number-sequence");
  expect(familyOf("NotRun: out-of-scope: Evaluate of `<5` into Decimal (form not pinned)")).toBe(
    "evaluate-comparison-decimal",
  );
});

// Red: count a kill as lost even when v3 still killed the mutant (another test).
test("a BC kill is lost only when v3 did not kill it (survived, error or no-coverage); refused-only reach counts per family", () => {
  const refused = new Map([
    ["T.Seq", SEQ],
    ["T.Rel", REL],
  ]);
  const bc = report([
    { line: 1, verdict: "killed", killingTest: "Seq", coveringTests: ["T.Seq", "T.Ok"] },
    { line: 2, verdict: "killed", killingTest: "Seq", coveringTests: ["T.Seq", "T.Ok"] },
    { line: 3, verdict: "survived", coveringTests: ["T.Seq", "T.Rel"] },
    { line: 4, verdict: "killed", killingTest: "Seq", coveringTests: ["T.Seq"] },
  ]);
  const v3 = report([
    { line: 1, verdict: "survived" },
    { line: 2, verdict: "killed", killingTest: "Ok" },
    { line: 3, verdict: "error", failureNote: REL },
    { line: 4, verdict: "no-coverage" },
  ]);
  const c = costOf("run", v3, refused, [bc]);
  expect(c.joined).toBe(4);
  expect(c.families["number-sequence"]).toEqual({
    testsRefused: 1,
    errorMutants: 0,
    cascadeErrors: 0,
    killsLost: 2,
    reachedOnlyByRefused: 2,
  });
  expect(c.families.relationfieldno).toEqual({
    testsRefused: 1,
    errorMutants: 1,
    cascadeErrors: 0,
    killsLost: 0,
    reachedOnlyByRefused: 1,
  });
});

// Red: read only "killed" as a kill (PR-494): BC's timeout kill that v3 refused is no longer lost (number-sequence 0),
// and a BC kill that v3 timeout-killed reads as lost (relationfieldno 1). One family per direction, so they cannot
// cancel out.
test("timeout-killed is a kill on both sides, as LethAL's score counts it", () => {
  const refused = new Map([
    ["T.Seq", SEQ],
    ["T.Rel", REL],
  ]);
  const bc = report([
    { line: 1, verdict: "timeout-killed", killingTest: "Seq", coveringTests: ["T.Seq"] },
    { line: 2, verdict: "killed", killingTest: "Rel", coveringTests: ["T.Rel"] },
  ]);
  const v3 = report([
    { line: 1, verdict: "error", failureNote: SEQ },
    { line: 2, verdict: "timeout-killed", killingTest: "Rel" },
  ]);
  const c = costOf("run", v3, refused, [bc]);
  expect(c.families["number-sequence"]?.killsLost).toBe(1);
  expect(c.families.relationfieldno?.killsLost).toBe(0);
});

// Red: credit a cascade by its truncated quote: it lands in untouched-handle, not in the earlier test's family.
test("a cascade error is credited to the earlier refused test's own family, not to its note's truncated quote", () => {
  const refused = new Map([["Some Tests.Earlier", REL]]);
  const note =
    "NotRun: out-of-scope: an earlier test of this codeunit was refused while it ran (Earlier: did not run (an OutStream was expected, got an ): part of its reach is not known";
  const c = costOf("run", report([{ line: 1, verdict: "error", failureNote: note }]), refused);
  expect(c.families.relationfieldno?.cascadeErrors).toBe(1);
  expect(c.families["untouched-handle"]).toBeUndefined();
  expect(c.families["reach-cascade"]).toBeUndefined();
  // a cascade whose earlier test is not among the refused falls back to the note's own family, still as a cascade
  const lone = costOf("run", report([{ line: 1, verdict: "error", failureNote: note }]), new Map());
  expect(
    lone.families["untouched-handle"]?.cascadeErrors ??
      lone.families["reach-cascade"]?.cascadeErrors,
  ).toBe(1);
  expect(familyOf(OUT)).toBe("untouched-handle");
});

// Red: print the unmapped text itself, or number U by first appearance instead of sorted order.
test("the shared file withholds unmapped texts; the private list numbers them in sorted order, quotes normalised", () => {
  const v3 = report([
    { line: 1, verdict: "error", failureNote: "NotRun: out-of-scope: zeta thing 'Secret Name'" },
    { line: 2, verdict: "error", failureNote: "NotRun: out-of-scope: alpha thing" },
  ]);
  const c = costOf("run", v3, new Map());
  const md = render([c]);
  expect(md).toContain("unmapped text U1 (withheld");
  expect(md).toContain("unmapped text U2 (withheld");
  expect(md).not.toContain("Secret Name");
  expect(unmappedTexts([c])).toEqual([
    "U1\tNotRun: out-of-scope: alpha thing",
    "U2\tNotRun: out-of-scope: zeta thing <x>",
  ]);
});

// Red: take the max over runs instead of the sum: RelationFieldNo (1 + 1) no longer outranks number-sequence (1).
test("the ranking sums over the runs; a run without BC shows dashes for the joined columns", () => {
  const a = costOf("a", report([{ line: 1, verdict: "error", failureNote: REL }]), new Map());
  const b = costOf(
    "b",
    report([
      { line: 1, verdict: "error", failureNote: REL },
      { line: 2, verdict: "survived" },
    ]),
    new Map([["T.Seq", SEQ]]),
    [report([{ line: 2, verdict: "killed", killingTest: "Seq", coveringTests: ["T.Seq"] }])],
  );
  const md = render([a, b]);
  const rows = md.split("\n").filter((l) => /^\| \d+ \|/.test(l));
  expect(rows[0]).toContain("#8592");
  expect(rows[1]).toContain("#8002");
  expect(rows[0]).toContain("| 0 / 1 / 0 / - / - |");
});

// Red: read every run (not the latest), or keep a nameless row.
test("the store reader takes the latest run's non-pass baseline rows and refuses a nameless row", () => {
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
    const db2 = new Database(path);
    db2.run("insert into test_results values (2, null, null, 'Nameless', 'fail', 'x')");
    db2.close();
    expect(() => baselineRefusals(path)).toThrow(/no codeunit name/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
