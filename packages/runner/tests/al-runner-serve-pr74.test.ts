// PR-74: the keep entries for the refusal families DO window t9 met, measured CLEAN by PR-54's strict census
// (`/coord/handoff/PR-74/census/`, invented cells of family `t9-refusals`). `pr74-measured-refusals.json` holds
// the texts the census measured per class and the V3_SERVE_SAFE_REFUSALS entry that keeps them.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { V3_SERVE_SAFE_REFUSALS, serveDaemonReusable } from "../src/al-runner-server";

const P = "NotRun: out-of-scope: ";
const read = (f: string) =>
  JSON.parse(readFileSync(join(import.meta.dir, f), "utf8")) as {
    cls: string;
    entry: string | null;
    texts: string[];
  }[];
const measured = read("pr74-measured-refusals.json");
const keeps = (m: string, notRun = true): boolean =>
  serveDaemonReusable([{ name: "C.X1", status: "error", notRun, message: m }], "v3");
const names = Object.keys(V3_SERVE_SAFE_REFUSALS);

describe("PR-74 keep entries", () => {
  test("every measured text is kept, by its own entry and by no other entry", () => {
    expect(measured.length).toBe(9);
    for (const c of measured)
      for (const t of c.texts) {
        expect([t, keeps(P + t)]).toEqual([t, true]);
        const by = names.filter((n) => V3_SERVE_SAFE_REFUSALS[n]?.test(P + t));
        expect(c.entry).not.toBeNull();
        expect([t, by]).toEqual([t, c.entry === null ? [] : [c.entry]]);
      }
  });

  test("a reworded text closes: a tail, a prefix, a line break, a dropped end", () => {
    for (const c of measured)
      for (const t of c.texts)
        for (const m of [`${t} x`, `x ${t}`, `${t}\n`, t.slice(0, -1)])
          expect([m, keeps(P + m)]).toEqual([m, false]);
    expect(keeps(`${P}conversion of Boolean false to BigInteger`, false)).toBe(false);
  });

  test("only the measured variants: other operators, operands, methods and paths close", () => {
    const k = (m: string) => keeps(P + m);
    for (const op of ["<", ">", "|", "&", "=", "*"])
      expect([op, k(`SetFilter: value expected after ${op}`)]).toEqual([op, false]);
    for (const v of [">10", ">=100", "<100", "100..", ">1000.5"])
      expect([v, k(`Evaluate of \`${v}\` into Decimal (form not pinned by the corpus)`)]).toEqual([
        v,
        false,
      ]);
    expect(k("Evaluate of `>100` into Integer (form not pinned by the corpus)")).toBe(false);
    for (const r of ["Run", "RunModal", "Print", "Execute", "SaveAsPdf"])
      expect([
        r,
        k(
          `a parameters string without the XML declaration in this form, given to Report.${r} (which character BC's filter error names is not pinned)`,
        ),
      ]).toEqual([r, false]);
    // R945's closes stay closed (review M3 of PR-56): FieldRef.Value, RecordRef.Get and CopyLinks
    for (const m of ["Value", "Get", "CopyLinks", "Mark", "Duplicates"]) {
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
    // the other conversions to BigInteger, and true
    for (const f of ["Boolean true", "Code GL0", "Text x", "Decimal 1.5"])
      expect([f, k(`conversion of ${f} to BigInteger`)]).toEqual([f, false]);
  });

  test("the JSON writer entries: t9's paths are kept; other states, methods and exceptions close", () => {
    const start = (path: string) =>
      `${P}DotNet Newtonsoft.Json.JsonTextWriter.WriteStartObject raised the .NET exception Newtonsoft.Json.JsonWriterException: Token StartObject in state Object would result in an invalid JSON object. Path '${path}'.; the text AL would see is not pinned (ADR-014 section 7)`;
    for (const p of ["a", "message", "message.ccRecipients[0]", ""])
      expect([p, keeps(start(p))]).toEqual([p, true]);
    for (const p of ["a'b", "a b", "a\nb", "x".repeat(61)])
      expect([p, keeps(start(p))]).toEqual([p, false]);
    // WritePropertyName was produced but not driven by the census: not kept
    expect(
      keeps(
        `${P}DotNet Newtonsoft.Json.JsonTextWriter.WritePropertyName raised the .NET exception Newtonsoft.Json.JsonWriterException: Token PropertyName in state ArrayStart would result in an invalid JSON object. Path 'a'.; the text AL would see is not pinned (ADR-014 section 7)`,
      ),
    ).toBe(false);
    // another state, or WriteEndObject with a path, closes
    expect(keeps(start("a").replace("in state Object", "in state Array"))).toBe(false);
    expect(
      keeps(
        `${P}DotNet Newtonsoft.Json.JsonTextWriter.WriteEndObject raised the .NET exception Newtonsoft.Json.JsonWriterException: No token to close. Path 'a'.; the text AL would see is not pinned (ADR-014 section 7)`,
      ),
    ).toBe(false);
    // the zip text with another inner exception closes
    expect(
      keeps(
        `${P}DotNet new System.IO.Compression.ZipArchive raised the .NET exception System.IO.InvalidDataException: Central Directory corrupt.; the text AL would see is not pinned (ADR-014 section 7)`,
      ),
    ).toBe(false);
  });

  test("no new PR-74 entry matches a text PR-54's census measured for another class", () => {
    const mine = new Set(measured.map((c) => c.entry));
    const pr56 = read("pr56-measured-refusals.json");
    for (const c of pr56)
      for (const t of c.texts) {
        if (c.entry !== null && mine.has(c.entry)) continue; // a class PR-74 widened
        const hit = [...mine].filter((n) => n !== null && V3_SERVE_SAFE_REFUSALS[n]?.test(P + t));
        expect([t, hit]).toEqual([t, []]);
      }
  });
});
