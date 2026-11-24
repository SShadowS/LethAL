// PR-411 (spec 2026-11-24-pr411-r1205-keep-families.md v2, R1205): three refusal families c4 still closed daemons on are kept
// EXACTLY, one row per measured line (c4's captured text), each after its own kept-vs-fresh DO check
// (/coord/handoff/PR-411/keepcheck/). F1a (SaveAs as Pdf, whose text carries upstream corpus paths) is NOT kept.
import { describe, expect, test } from "bun:test";
import { V3_SERVE_SAFE_REFUSALS, serveDaemonReusable } from "../src/al-runner-server";

const P = "NotRun: out-of-scope: ";
const PDF = (report: string) =>
  `a read of the content of a placeholder Pdf of report ${report} (the runtime writes a placeholder, not BC's rendering: only that the output exists and is not empty, and that a PDF starts with the bytes '%PDF-' matches BC; a test that reads the content tests the layout renderer)`;
const EVALBOOL = (lang: string) =>
  `the error of Evaluate into a Boolean under GlobalLanguage ${lang} (not measured)`;
const PARAMS = (method: string) =>
  `a parameters string without the XML declaration in this form, given to Report.${method} (which character BC's filter error names is not pinned)`;
// c4's lines, byte for byte (/coord/handoff/PR-411/lines.txt).
const LINES: ReadonlyArray<readonly [string, string]> = [
  ["placeholder-pdf-read-standard-statement", PDF("Standard Statement")],
  ["placeholder-pdf-read-standard-sales-invoice", PDF("Standard Sales - Invoice")],
  ["evaluate-boolean-global-language-1044", EVALBOOL("1044")],
  ["run-request-page-parameters-no-xml-declaration", PARAMS("RunRequestPage")],
];
const keeps = (m: string, notRun = true): boolean =>
  serveDaemonReusable([{ name: "C.X1", status: "error", notRun, message: m }], "v3");
/** The keep entries that match a line: each real line must be kept by its OWN entry. */
const keptBy = (m: string): string[] =>
  Object.entries(V3_SERVE_SAFE_REFUSALS)
    .filter(([, re]) => re.test(m))
    .map(([name]) => name);

describe("PR-411: R1205's three families", () => {
  // Red: remove any of the four PR56_KEPT rows.
  test.each(LINES)("c4's line is kept by its own exact entry: %s", (name, line) => {
    expect(keeps(P + line)).toBe(true);
    // its own entry and NO other (build review 3): a later broad entry that also matched would turn this red
    expect(keptBy(P + line)).toEqual([name]);
  });

  // Red: widen a row with a slot or a broad pattern.
  test.each([
    ["another report (placeholder Pdf read)", PDF("Standard Sales - Credit Memo")],
    ["GlobalLanguage 1030", EVALBOOL("1030")],
    ["GlobalLanguage 1045", EVALBOOL("1045")],
    ["a tail appended to the Evaluate line", `${EVALBOOL("1044")}; more`],
    ["a tail appended to the Pdf line", `${PDF("Standard Statement")} more`],
    ["a tail appended to the RunRequestPage line", `${PARAMS("RunRequestPage")} more`],
    [
      "F1a, the SaveAs as Pdf line (not kept: its text carries upstream corpus paths)",
      // c4's line up to its corpus pointers (the full line names upstream test files with line numbers)
      'Report.SaveAs as Pdf of report "Standard Statement": not measured on BC. Never measured: data items = another tree (measured: one; three top-level; two top-level).',
    ],
  ])("an unmeasured near miss still closes: %s", (_name, line) => {
    expect(keeps(P + line)).toBe(false);
  });

  test("the generic RunRequestPage text in a session without a client stays kept by its own entry, not a new one", () => {
    const line = `${P}Report.RunRequestPage in a session without a client (--no-client): what BC does there is not pinned (probe wanted, docs/probes-needed.md \`no-client-session\`)`;
    expect(keptBy(line)).toEqual(["no-client-run-request-page"]);
  });

  test("F3's SaveAs sibling stays kept by PR-74's row only, never by the new RunRequestPage row", () => {
    const names = keptBy(P + PARAMS("SaveAs"));
    expect(names.length).toBe(1);
    expect(names).not.toContain("run-request-page-parameters-no-xml-declaration");
  });

  test("the Pdf line's '%PDF-' is text, not a slot: the entry compiles and matches the literal", () => {
    const re = V3_SERVE_SAFE_REFUSALS["placeholder-pdf-read-standard-statement"];
    expect(re?.test(P + PDF("Standard Statement"))).toBe(true);
    expect(re?.test(P + PDF("Standard Statement").replace("'%PDF-'", "'PDF-'"))).toBe(false);
  });

  test("a non-refusal row with the same text never counts as kept", () => {
    for (const [, line] of LINES) expect(keeps(P + line, false)).toBe(false);
  });
});
