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
    const own = new Map(measured.flatMap((c) => c.texts.map((t) => [t, c.entry] as const)));
    let hits = 0;
    for (const { key } of ledger) {
      if (!key.startsWith(P)) continue;
      const raw = key.replace(/<x>/g, "'x.y'").replace(/\(N\)/g, "(1)").replace(/\bN\b/g, "1");
      const matched = NEW.filter((n) => V3_SERVE_SAFE_REFUSALS[n]?.test(raw));
      expect([key, matched.length <= 1]).toEqual([key, true]);
      hits += matched.length;
    }
    expect(own.size).toBeGreaterThan(100);
    expect(hits).toBeGreaterThan(0);
  });

  test("a pattern is bounded: a long or multi-line variable part, or a ':' where none was measured, closes", () => {
    const k = (m: string) => keeps(P + m);
    expect(
      k(
        "Foo on the Company table: the database may hold companies this runtime does not know (ADR-046 decision 4a)",
      ),
    ).toBe(true);
    expect(
      k(
        "Foo.Bar on the Company table: the database may hold companies this runtime does not know (ADR-046 decision 4a)",
      ),
    ).toBe(false);
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
