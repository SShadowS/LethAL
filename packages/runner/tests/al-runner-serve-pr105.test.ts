// PR-105: the keep entries for the texts DO windows t12/t13 still closed on, measured CLEAN by PR-54's strict census
// with every distinct text a refuser (`/coord/handoff/PR-105/census/`, invented cells of family `t12-refusals`).
// `pr105-measured-refusals.json` holds the measured texts and the V3_SERVE_SAFE_REFUSALS entry that keeps each.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { V3_SERVE_SAFE_REFUSALS, serveDaemonReusable } from "../src/al-runner-server";

const P = "NotRun: out-of-scope: ";
const measured = JSON.parse(
  readFileSync(join(import.meta.dir, "pr105-measured-refusals.json"), "utf8"),
) as { cls: string; entry: string; texts: string[] }[];
const keeps = (m: string, notRun = true): boolean =>
  serveDaemonReusable([{ name: "C.X1", status: "error", notRun, message: m }], "v3");
const names = Object.keys(V3_SERVE_SAFE_REFUSALS);
const nul = (n: number) => "\u0000".repeat(n);

describe("PR-105 keep entries", () => {
  test("every measured text is kept by its own entry and by no other", () => {
    expect(measured.flatMap((c) => c.texts)).toHaveLength(12);
    for (const c of measured)
      for (const t of c.texts) {
        const by = names.filter((n) => V3_SERVE_SAFE_REFUSALS[n]?.test(P + t));
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

  test("only the measured variants: other widths, texts and codes close", () => {
    const k = (m: string) => keeps(P + m);
    const ev = (v: string) => `Evaluate of \`${v}\` into Decimal (form not pinned by the corpus)`;
    // measured widths are 4, 5 and 6 NUL characters
    for (const n of [0, 1, 3, 7, 40]) expect([n, k(ev(nul(n)))]).toEqual([n, false]);
    for (const v of [" ".repeat(5), `${nul(2)}  ${nul(2)}`, `${nul(4)}1`, `${nul(3)}\n`])
      expect([v, k(ev(v))]).toEqual([v, false]);
    for (const v of ["=19", "=1", "18", "2=18", "=18 ", "1=18=18", ""])
      expect([v, k(`conversion of Text '${v}' to Integer`)]).toEqual([v, false]);
    for (const c of ["C10001", "C1000", "c10000", "X1"])
      expect([c, k(`SetFilter: \`${c}\` is not a BigInteger`)]).toEqual([c, false]);
    const start = (path: string) =>
      `DotNet Newtonsoft.Json.JsonTextWriter.WriteStartObject raised the .NET exception Newtonsoft.Json.JsonWriterException: Token StartObject in state Object would result in an invalid JSON object. Path '${path}'.; the text AL would see is not pinned (ADR-014 section 7)`;
    for (const p of ["message.body.ccRecipients[1].emailAddress", "message.body.emailAddress"])
      expect([p, k(start(p))]).toEqual([p, false]);
    expect(k("conversion of Text 'x' to Blob")).toBe(false);
    expect(k('conversion of Text \'<?xml version="1.0" encoding="utf-8"\' to Blob')).toBe(false);
    expect(k("conversion of Text '=18' to Decimal")).toBe(false);
    expect(k("FieldRef.CalcField of a FlowField (not pinned)")).toBe(false);
    expect(k("Report.SaveAs#2 to an untouched handle")).toBe(false);
    expect(k("CopyStream from an untouched handle into a Text")).toBe(false);
  });

  test("the close texts that stay out of reach still close", () => {
    const k = (m: string) => keeps(P + m);
    // PR-74 review H1 stands: RunRequestPage was measured only after a Commit()
    expect(
      k(
        "a parameters string without the XML declaration in this form, given to Report.RunRequestPage (which character BC's filter error names is not pinned)",
      ),
    ).toBe(false);
    // the SaveAs-with-layout errors (the first half is al-runner's wording; the report's own error text is left out)
    for (const r of ["Standard Sales - Invoice", "Standard Statement"])
      expect(
        k(
          `an error in a SaveAs of report "${r}", which has a layout of this kind or an extension (whether SaveAs raises it or answers false is not pinned): x`,
        ),
      ).toBe(false);
    expect(
      k(
        "a read of the content of a placeholder Pdf of report Standard Sales - Invoice (the runtime writes a placeholder, not BC's rendering)",
      ),
    ).toBe(false);
    // the list-without-the-new-row-line text no cell produced
    expect(
      k("a list without the new-row line that lost its only row to an action (not pinned)"),
    ).toBe(false);
  });
});
