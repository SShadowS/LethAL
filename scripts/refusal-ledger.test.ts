import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_LEDGER,
  RefusalLedgerError,
  loadLedger,
  normaliseRefusal,
  readReport,
  readStore,
  refusalKind,
  render,
  tally,
} from "./refusal-ledger.ts";

const SUFFIX =
  " [al-runner v3 did not run this test (notRun), so whether the mutant changes its outcome on BC is unknown: NOT scored (R586 §5)]";
const NR = "NotRun: out-of-scope: ";
const dir = mkdtempSync(join(tmpdir(), "refusal-ledger-"));
const ledgerFile = (entries: unknown) => {
  const p = join(dir, `l${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(p, JSON.stringify(entries));
  return p;
};
const CALLBACK = "attempted to issue a client callback to show a confirmation dialog box: <text>";

describe("normaliseRefusal", () => {
  test("quoted names and literals, GUIDs and digits are masked; the al-runner suffix goes", () => {
    const guid = "{01234567-89ab-cdef-0123-456789abcdef}";
    expect(
      normaliseRefusal(
        `${NR}SetFilter: 'abc' is not an Integer in "Sales Line" 42 ${guid}${SUFFIX}`,
      ),
    ).toBe(`${NR}SetFilter: <x> is not an Integer in <x> N <guid>`);
  });
  test("a cascade and a no-green-baseline note are unwrapped to the refusal inside", () => {
    const inner = `${NR}SetFilter: empty filter term`;
    const cascade = `${NR}an earlier test of this codeunit was refused while it ran (TestA: did not run (SetFilter: empty filter term))${SUFFIX}`;
    expect([normaliseRefusal(cascade), refusalKind(cascade)]).toEqual([inner, "cascade"]);
    const note = `no green baseline tests — all 7 failed with the same message: ${inner}`;
    expect([normaliseRefusal(note), refusalKind(note)]).toEqual([inner, "baseline"]);
    expect(refusalKind(inner)).toBe("mutant");
  });
  test("a cascade's quoted failure (app text), its earlier test's name and its quoted refusal are masked", () => {
    const failed = `${NR}a test before this one in the codeunit did not pass (TestB: failed (Document service is not configured (setup))) and left a manual event subscription bound`;
    expect(normaliseRefusal(failed)).toBe(
      `${NR}a test before this one in the codeunit did not pass (<test>: failed (<failure>)) and left a manual event subscription bound`,
    );
    const reach = `${NR}an earlier test of this codeunit was refused while it ran (TestC: did not run (view field 'X')): part of its reach is not known (runs page 5, which is not`;
    expect(normaliseRefusal(reach)).toBe(
      `${NR}an earlier test of this codeunit was refused while it ran (<test>: did not run (<refusal>)): part of its reach is not known (<reach>`,
    );
    const seq = `${NR}an earlier test of this codeunit, TestD, changed number sequence 'S'`;
    expect(normaliseRefusal(seq)).toBe(
      `${NR}an earlier test of this codeunit, <test>, changed number sequence <x>`,
    );
  });
  test("a client callback's quoted question (app text) is masked", () => {
    const text =
      "Microsoft Dynamics 365 Business Central Server attempted to issue a client callback to show a confirmation dialog box: Do you want to post? (CodeUnit 1)";
    expect(normaliseRefusal(text)).toBe(`Microsoft Dynamics N Business Central Server ${CALLBACK}`);
  });
  test("a key is a fixed point, also when the 220-character cut ends on a space", () => {
    const k = normaliseRefusal(`${NR}${"word ".repeat(80)}`);
    expect(k.length).toBeLessThanOrEqual(220);
    expect(normaliseRefusal(k)).toBe(k);
  });
});

describe("the ledger", () => {
  // red both ways: the committed ledger knows this text, and a changed wording of it is new
  test("a known text matches the committed ledger; a changed wording is NEW", () => {
    const ledger = loadLedger(DEFAULT_LEDGER);
    const rows = tally(
      [
        { text: `${NR}SetFilter: empty filter term${SUFFIX}`, kind: "mutant", where: "a" },
        { text: `${NR}SetFilter: an empty filter term${SUFFIX}`, kind: "mutant", where: "b" },
      ],
      ledger,
    );
    expect(rows.map((r) => [r.key, r.entry?.state])).toEqual([
      [`${NR}SetFilter: an empty filter term`, undefined],
      [`${NR}SetFilter: empty filter term`, "fixed"],
    ]);
    const out = render(rows);
    expect(out).toContain("1 known, 1 NEW");
    expect(out.slice(out.indexOf("NEW, to reduce"))).toContain("SetFilter: an empty filter term");
  });
  // loadLedger itself refuses a key that is not normalised, so no quoted name or literal is left
  // (a lone apostrophe, as in "BC's", is al-runner's own English)
  test("the committed ledger loads, and every key is one of the known shapes", () => {
    const ledger = loadLedger(DEFAULT_LEDGER);
    expect(ledger.size).toBeGreaterThan(300);
    for (const k of ledger.keys()) {
      // no source text: an al-runner refusal, or one of the two platform shapes, app text masked
      const known =
        k.startsWith("NotRun: ") ||
        k.startsWith("al-runner-vN transport failure: ") ||
        k.endsWith(CALLBACK);
      expect([k, known]).toEqual([k, true]);
    }
  });
  test("refuses a key that is not normalised, an unknown state, a duplicate, a missing file", () => {
    const k = `${NR}SetFilter: empty filter term`;
    const bad = ledgerFile([{ key: "NotRun: 'x'", state: "open" }]);
    expect(() => loadLedger(bad)).toThrow(/not normalised/);
    expect(() => loadLedger(ledgerFile([{ key: k, state: "closed" }]))).toThrow(/unknown state/);
    const dup = ledgerFile([
      { key: k, state: "open" },
      { key: k, state: "fixed" },
    ]);
    expect(() => loadLedger(dup)).toThrow(/duplicate/);
    expect(() => loadLedger(join(dir, "none.json"))).toThrow(RefusalLedgerError);
  });
});

describe("inputs", () => {
  const SQL = [
    "create table runs (id integer primary key, backend text, finished_at text)",
    "create table mutants (id integer primary key, run_id int, mutant_code text, verdict text, failure_note text)",
    "create table test_results (id integer primary key, run_id int, mutant_row_id int, codeunit_id int, codeunit_name text, method text, outcome text, failure_message text)",
    // run 1 (older) is not read by default; run 3 is not finished
    "insert into runs values (1, 'al-runner-v3', 'x'), (2, 'al-runner-v3', 'y'), (3, 'al-runner-v3', null)",
    `insert into mutants values (1, 1, 'M0001', 'error', '${NR}old')`,
    `insert into mutants values (2, 2, 'M0001', 'error', '${NR}from the note')`,
    `insert into mutants values (3, 2, 'M0002', 'error', '${NR}the note loses')`,
    "insert into mutants values (4, 2, 'M0003', 'killed', null)",
    `insert into test_results values (1, 2, 3, 5, 'C', 'T', 'error', '${NR}from the test')`,
    `insert into test_results values (2, 2, null, 5, 'C', 'T', 'error', '${NR}a baseline refusal')`,
    "insert into test_results values (3, 2, null, 5, 'C', 'U', 'fail', 'Assert failed')",
  ];
  const store = () => {
    const p = join(dir, `s${Math.random().toString(36).slice(2)}.sqlite`);
    const db = new Database(p);
    for (const s of SQL) db.run(s);
    db.close();
    return p;
  };
  test("a store: the newest finished v3 run's error mutants (test message first) and its refused baseline rows", () => {
    expect(readStore(store()).map((x) => [x.text, x.kind])).toEqual([
      [`${NR}from the note`, "mutant"],
      [`${NR}from the test`, "mutant"],
      [`${NR}a baseline refusal`, "test"],
    ]);
    expect(readStore(store(), 1).map((x) => x.text)).toEqual([`${NR}old`]);
  });
  test("a store with no finished v3 run is refused by name", () => {
    const p = join(dir, "empty.sqlite");
    const db = new Database(p);
    db.run("create table runs (id integer primary key, backend text, finished_at text)");
    db.close();
    expect(() => readStore(p)).toThrow(/no finished al-runner-v3 run/);
  });
  test("a report: each error mutant's failure note", () => {
    const p = join(dir, "r.json");
    const mutants = [
      { mutantCode: "M1", verdict: "error", failureNote: `${NR}x` },
      { mutantCode: "M2", verdict: "survived" },
    ];
    writeFileSync(p, JSON.stringify({ mutants }));
    expect(readReport(p).map((x) => [x.text, x.where.endsWith("M1")])).toEqual([[`${NR}x`, true]]);
  });
});
