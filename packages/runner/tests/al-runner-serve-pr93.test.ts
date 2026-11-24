// PR-93: the keep entries for the texts DO windows t10/t11 still closed on, measured CLEAN by PR-54's strict census
// with every distinct text a refuser (`/coord/handoff/PR-93/census2/`, invented cells of family `t10-refusals`).
// `pr93-measured-refusals.json` holds the measured texts and the V3_SERVE_SAFE_REFUSALS entry that keeps each (null:
// measured but deliberately not kept).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { V3_SERVE_SAFE_REFUSALS, serveDaemonReusable } from "../src/al-runner-server";

const P = "NotRun: out-of-scope: ";
const measured = JSON.parse(
  readFileSync(join(import.meta.dir, "pr93-measured-refusals.json"), "utf8"),
) as {
  cls: string;
  entry: string | null;
  texts: string[];
}[];
const keeps = (m: string, notRun = true): boolean =>
  serveDaemonReusable([{ name: "C.X1", status: "error", notRun, message: m }], "v3");
const names = Object.keys(V3_SERVE_SAFE_REFUSALS);

describe("PR-93 keep entries", () => {
  // The `entry: null` branch (a measured text that closes) has had no member since PR-411 kept the RunRequestPage text by
  // its own row; it stays, so a text measured as unkept in this file would still be checked to close.
  test("every measured text is kept by its own entry and by no other (none is unkept since PR-411)", () => {
    expect(measured.flatMap((c) => c.texts)).toHaveLength(27);
    for (const c of measured)
      for (const t of c.texts) {
        const by = names.filter((n) => V3_SERVE_SAFE_REFUSALS[n]?.test(P + t));
        if (c.entry === null) {
          expect([t, keeps(P + t), by]).toEqual([t, false, []]);
          continue;
        }
        expect([t, keeps(P + t)]).toEqual([t, true]);
        expect([t, by]).toEqual([t, [c.entry]]);
      }
  });

  test("a reworded text closes: a tail, a prefix, a line break, a dropped end, and a row that is not notRun", () => {
    for (const c of measured)
      for (const t of c.texts) {
        for (const m of [`${t} x`, `x ${t}`, `${t}\n`, t.slice(0, -1)])
          expect([m, keeps(P + m)]).toEqual([m, false]);
        expect([t, keeps(P + t, false)]).toEqual([t, false]);
      }
  });

  test("only the measured variants: other methods, values, codes, states and texts close", () => {
    const k = (m: string) => keeps(P + m);
    const tail = ": what BC does (an error, or a no-op) is not pinned (docs/probes-needed.md)";
    for (const m of ["Get", "CopyLinks", "Mark", "Name", "Number"])
      expect([m, k(`FieldRef.${m} on a FieldRef that was never assigned${tail}`)]).toEqual([
        m,
        false,
      ]);
    const rr =
      " on a RecordRef that is not open: BC's error text, and whether Get(RecordId) opens the table of the RecordId, are not pinned (docs/probes-needed.md)";
    // (FindSet is kept by R945's own entry, measured there)
    for (const m of ["Get", "FindLast", "CopyLinks", "ReadPermission", "Count"])
      expect([m, k(`RecordRef.${m}${rr}`)]).toEqual([m, false]);
    for (const m of ["FieldIndex2", "Active", "Record"])
      expect([m, k(`KeyRef.${m} on a KeyRef that was never assigned`)]).toEqual([m, false]);
    for (const op of ["`<`", "`>`", "`=`", "<>"])
      expect([op, k(`SetFilter: value expected after ${op}`)]).toEqual([op, false]);
    expect(k("SetFilter: unexpected `>` in filter `<-2M>..<CM>`")).toBe(false);
    expect(k("SetFilter: unexpected `<` in filter `<-1M>..<CM>`")).toBe(false);
    const dt = (v: string) =>
      `SetFilter: text filter value \`${v}\` for Date: no form pinned for this language (formulas and other region formats are not pinned, docs/probes-needed.md)`;
    for (const v of ["-2M", "-1W", "2026-09-01", "-2026-09-02"])
      expect([v, k(dt(v))]).toEqual([v, false]);
    for (const c of ["GL00000001", "GU00000000", "X1"])
      expect([c, k(`SetFilter: \`${c}\` is not a BigInteger`)]).toEqual([c, false]);
    for (const v of ["<301", "<30", ">300"])
      expect([v, k(`Evaluate of \`${v}\` into Decimal (form not pinned by the corpus)`)]).toEqual([
        v,
        false,
      ]);
    expect(k("RecordRef.GetTable of Text 'x'")).toBe(false);
    expect(k("conversion of Code 'GL0' to BigInteger")).toBe(false);
    expect(k("Report.SaveAs#2 of id 1, which no report declares (error text not pinned)")).toBe(
      false,
    );
    const pn = (state: string, path: string) =>
      `DotNet Newtonsoft.Json.JsonTextWriter.WritePropertyName raised the .NET exception Newtonsoft.Json.JsonWriterException: Token PropertyName in state ${state} would result in an invalid JSON object. Path '${path}'.; the text AL would see is not pinned (ADR-014 section 7)`;
    expect(k(pn("Object", "message.toRecipients"))).toBe(false);
    expect(k(pn("Array", "message.ccRecipients"))).toBe(false);
    expect(
      k(
        "DotNet Newtonsoft.Json.JsonTextWriter.WriteEndArray raised the .NET exception Newtonsoft.Json.JsonWriterException: No token to close. Path 'a'.; the text AL would see is not pinned (ADR-014 section 7)",
      ),
    ).toBe(false);
    // PR-74 review H1 stood for PR-93 (RunRequestPage measured only after a Commit()). PR-411 keeps DO's exact line by its
    // own row after its own kept-vs-fresh DO check; that row's entry is now this text's in pr93-measured-refusals.json.
    expect(
      k(
        "a parameters string without the XML declaration in this form, given to Report.RunRequestPage (which character BC's filter error names is not pinned)",
      ),
    ).toBe(true);
  });
});
