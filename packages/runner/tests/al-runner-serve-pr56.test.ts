// PR-56: the keep entries for every CLEAN class of PR-54's keep census. `pr56-measured-refusals.json` holds,
// per class, the texts the census MEASURED (invented AL, `/coord/handoff/PR-54/run2`); `entry` is the
// V3_SERVE_SAFE_REFUSALS name that keeps the class (null: an earlier entry already kept all of it).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { V3_SERVE_SAFE_REFUSALS, serveDaemonReusable } from "../src/al-runner-server";

const P = "NotRun: out-of-scope: ";
const measured = JSON.parse(
  readFileSync(join(import.meta.dir, "pr56-measured-refusals.json"), "utf8"),
) as { cls: string; entry: string | null; texts: string[] }[];
// `dotnet-exception` is an older entry that PR-56 widened (two exception types), not a new one.
const NEW = measured.flatMap((c) =>
  c.entry !== null && c.entry !== "dotnet-exception" ? [c.entry] : [],
);
const keeps = (m: string, notRun = true): boolean =>
  serveDaemonReusable([{ name: "C.X1", status: "error", notRun, message: m }], "v3");

describe("PR-56 keep entries", () => {
  test("the census has 74 CLEAN classes and every measured text of every class is kept", () => {
    expect(measured.length).toBe(74);
    expect(NEW.length).toBe(66);
    for (const c of measured)
      for (const t of c.texts) expect([c.cls, t, keeps(P + t)]).toEqual([c.cls, t, true]);
  });

  test("a class with an entry: its entry matches every measured text, and no other new entry matches one", () => {
    for (const c of measured) {
      if (c.entry === null || c.entry === "dotnet-exception") continue; // the latter: kept by several entries
      const own = V3_SERVE_SAFE_REFUSALS[c.entry];
      expect(own).toBeDefined();
      for (const t of c.texts) {
        expect([c.entry, t, own?.test(P + t)]).toEqual([c.entry, t, true]);
        const others = NEW.filter((n) => n !== c.entry && V3_SERVE_SAFE_REFUSALS[n]?.test(P + t));
        expect([t, others]).toEqual([t, []]);
      }
    }
  });

  test("each new entry refuses a reworded text: a tail, a prefix, a line break, a dropped end, a timeout word", () => {
    for (const c of measured) {
      if (c.entry === null || c.entry === "dotnet-exception") continue;
      const re = V3_SERVE_SAFE_REFUSALS[c.entry];
      for (const t of c.texts) {
        // the table name leads the permission-set text and may hold spaces, so a prefix is a longer name
        const prefixed = c.entry === "permission-set-whole-object-type" ? [] : [`x ${t}`];
        const lower = t.toLowerCase() === t ? [] : [t.toLowerCase()];
        for (const m of [`${t} x`, ...prefixed, `${t}\n`, t.slice(0, -1), ...lower]) {
          expect([c.entry, m, re?.test(P + m)]).toEqual([c.entry, m, false]);
          expect([c.entry, m, keeps(P + m)]).toEqual([c.entry, m, false]);
        }
      }
    }
    // notRun false is a plain error row, never kept
    expect(keeps(`${P}conversion of Blob to Integer`, false)).toBe(false);
  });

  test("no new entry matches a ledger key outside its class (a key matches at most one new entry, and a measured class's own)", () => {
    const ledger = JSON.parse(
      readFileSync(join(import.meta.dir, "../../../docs/measurements/refusal-ledger.json"), "utf8"),
    ) as { key: string }[];
    // Frozen from PR-54's coverage.tsv: a ledger key -> its measured class (`cls`), and the measured raw
    // text that the ledger's normaliser maps to it (`raw`; the key itself has digits as N). A key not in
    // it is unmeasured.
    const frozen = JSON.parse(
      readFileSync(join(import.meta.dir, "pr56-ledger-classes.json"), "utf8"),
    ) as Record<string, { cls?: string; raw?: string }>;
    const entryOf = new Map(measured.map((c) => [c.cls, c.entry] as const));
    let hits = 0;
    let exactHits = 0;
    for (const { key } of ledger) {
      if (!key.startsWith(P)) continue;
      const exact = frozen[key]?.raw;
      const raw =
        exact ?? key.replace(/<x>/g, "'x.y'").replace(/\(N\)/g, "(1)").replace(/\bN\b/g, "1");
      const matched = NEW.filter((n) => V3_SERVE_SAFE_REFUSALS[n]?.test(raw));
      const cls = frozen[key]?.cls;
      const own = cls === undefined ? null : (entryOf.get(cls) ?? null);
      // a key matched by a new entry belongs to that entry's own class
      expect([key, matched.filter((n) => n !== own)]).toEqual([key, []]);
      hits += matched.length;
      if (exact !== undefined && matched.length > 0) exactHits += 1;
    }
    // 84 from PR-54's coverage.tsv, plus 9 ledger keys PR-130 added to two of its classes (RecordRef.* not open: 6;
    // FieldRef.* never assigned: 3), 1 PR-131 added ("Error with an ErrorInfo nobody created") and 1 PR-135 added (the
    // DeleteAll global filter group), each matched by that class's own entry.
    expect(Object.values(frozen).filter((f) => f.cls !== undefined).length).toBe(95);
    expect(hits).toBeGreaterThan(0);
    expect(exactHits).toBeGreaterThan(5); // the Company keys etc. are really tested, not only the guesses
  });

  test("a pattern is bounded: a long or multi-line variable part, or a ':' where none was measured, closes", () => {
    const k = (m: string) => keeps(P + m);
    expect(
      k(
        "IsEmpty on the Company table: the database may hold companies this runtime does not know (ADR-046 decision 4a)",
      ),
    ).toBe(true);
    // review M3: only the measured methods; Insert, Delete, any other name and a dotted one close
    for (const m of ["Insert", "Delete", "Foo", "Foo.Bar"])
      expect([
        m,
        k(
          `${m} on the Company table: the database may hold companies this runtime does not know (ADR-046 decision 4a)`,
        ),
      ]).toEqual([m, false]);
    // PR-93 measured FieldRef.Value and keeps it (`al-runner-serve-pr93.test.ts`); Name stands in as unmeasured
    for (const m of ["Name", "Get", "CopyLinks"]) {
      expect(
        k(
          `FieldRef.${m} on a FieldRef that was never assigned: what BC does (an error, or a no-op) is not pinned (docs/probes-needed.md)`,
        ),
      ).toBe(false);
      expect(
        k(
          `RecordRef.${m} on a RecordRef that is not open: BC's error text, and whether Get(RecordId) opens the table of the RecordId, are not pinned (docs/probes-needed.md)`,
        ),
      ).toBe(false);
    }
    // review L4: a carriage return never fits a name, a quoted name or a filter
    expect(
      k(
        "store error a\rb: permission set 'x': `table * = X` grants a whole object type (not listed row by row)",
      ),
    ).toBe(false);
    expect(
      k(
        "store error ab: permission set 'x\ry': `table * = X` grants a whole object type (not listed row by row)",
      ),
    ).toBe(false);
    expect(k("SetFilter: `a\rb` is not a Decimal")).toBe(false);
    expect(
      k(
        `${"F".repeat(31)} on the Company table: the database may hold companies this runtime does not know (ADR-046 decision 4a)`,
      ),
    ).toBe(false);
    expect(
      k(
        "a permission denial (read permission on object type 0 id 20000000000) whose error is not pinned yet (a FlowField over a system table); the test is not run",
      ),
    ).toBe(false);
    expect(
      k(
        "a permission denial (read permission on object type 0 id 2000000157) whose error is not pinned yet (a FlowField over a system table); the test is not run",
      ),
    ).toBe(true);
    expect(
      k(
        "Perm:x: permission set 'S': `table * = X` grants a whole object type (not listed row by row)",
      ),
    ).toBe(false);
    expect(
      k(
        "store error Metadata Permission: permission set 'a\nb': `table * = X` grants a whole object type (not listed row by row)",
      ),
    ).toBe(false);
    expect(k("SetFilter: `a b` is not a Boolean")).toBe(false);
    expect(k("SetFilter: `a b` is not a Decimal")).toBe(true);
  });

  test("dotnet-exception takes the two new exception types, still no other", () => {
    const x = (t: string) =>
      `${P}DotNet new System.UriBuilder raised the .NET exception ${t}: bad; the text AL would see is not pinned (ADR-014 section 7)`;
    for (const t of ["System.UriFormatException", "System.IndexOutOfRangeException"])
      expect([t, keeps(x(t))]).toEqual([t, true]);
    for (const t of [
      "System.TimeoutException",
      "System.UriFormatExceptionX",
      "System.OutOfMemoryException",
    ])
      expect([t, keeps(x(t))]).toEqual([t, false]);
  });
});
