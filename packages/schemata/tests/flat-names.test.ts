import { describe, expect, test } from "bun:test";
import { FLAT_NAMES_FILENAME, displayPathsOf, flatNamesFor, flatNamesSidecar } from "../src";

// R219: the flat name of a project `.al` file in a batch directory, and the way back.
describe("flatNamesFor (R219)", () => {
  test("a unique basename keeps its name; the record is empty", () => {
    const n = flatNamesFor(["src/A.Codeunit.al", "B.al"]);
    expect([n.flatOf("src/A.Codeunit.al"), n.flatOf("B.al")]).toEqual(["A.Codeunit.al", "B.al"]);
    expect(n.renamed.size).toBe(0);
    expect(flatNamesSidecar(n.renamed)).toBeUndefined();
    expect(n.projectPathOf("A.Codeunit.al")).toBe("src/A.Codeunit.al");
  });

  test("duplicates (case-insensitive, as Windows and alc see them) each get their own name", () => {
    const n = flatNamesFor([
      "UserControls/Label/ScannerUI.al",
      "UserControls/ScannerUI/scannerui.AL",
    ]);
    const a = n.flatOf("UserControls/Label/ScannerUI.al");
    const b = n.flatOf("UserControls/ScannerUI/scannerui.AL");
    expect(a).toMatch(/^ScannerUI\.[0-9a-f]{8}\.al$/);
    expect(b).toMatch(/^scannerui\.[0-9a-f]{8}\.AL$/);
    expect(a.toLowerCase()).not.toBe(b.toLowerCase());
    expect(n.projectPathOf(a)).toBe("UserControls/Label/ScannerUI.al");
    expect(n.projectPathOf(b.toUpperCase())).toBe("UserControls/ScannerUI/scannerui.AL");
    expect([...n.renamed.keys()].sort()).toEqual([a, b].sort());
  });

  // Pinned literals: the name must not depend on the platform's separator, and a dir differing
  // only in case is another dir (its hash differs), so two checkouts of one commit agree.
  test("the name is the same for either separator and pinned across platforms", () => {
    const both = ["Sales/Helper.Codeunit.al", "Purchase/Helper.Codeunit.al"];
    const posix = flatNamesFor(both);
    const win = flatNamesFor(both.map((p) => p.replaceAll("/", "\\")));
    expect(win.flatOf("Sales\\Helper.Codeunit.al")).toBe(posix.flatOf("Sales/Helper.Codeunit.al"));
    expect(posix.flatOf("Sales/Helper.Codeunit.al")).toBe("Helper.Codeunit.8de4e0ea.al");
    // A NESTED directory pins the separator the hash reads: `/`, from either input form.
    const nested = ["UserControls/Label/ScannerUI.al", "UserControls/ScannerUI/ScannerUI.al"];
    for (const paths of [nested, nested.map((p) => p.replaceAll("/", "\\"))]) {
      expect(flatNamesFor(paths).flatOf(paths[0] ?? "")).toBe("ScannerUI.b00bb38f.al");
    }
    expect(
      flatNamesFor(["sales/Helper.Codeunit.al", "Purchase/Helper.Codeunit.al"]).flatOf(
        "sales/Helper.Codeunit.al",
      ),
    ).not.toBe("Helper.Codeunit.8de4e0ea.al");
  });

  test("a name it cannot make unique is refused, naming both files", () => {
    const n = flatNamesFor(["Sales/Helper.Codeunit.al", "Purchase/Helper.Codeunit.al"]);
    const generated = n.flatOf("Sales/Helper.Codeunit.al");
    expect(() =>
      flatNamesFor(["Sales/Helper.Codeunit.al", "Purchase/Helper.Codeunit.al", `X/${generated}`]),
    ).toThrow(/would both be written as .*silently replace the other/);
  });

  test("a path it was not built over is refused, never invented", () => {
    expect(() => flatNamesFor(["A.al"]).flatOf("Other/A.al")).toThrow(
      /not one of the 1 project file/,
    );
  });

  test("the sidecar round-trips into display paths; a file it does not name is unchanged", () => {
    const n = flatNamesFor(["Sales/Helper.Codeunit.al", "Purchase/Helper.Codeunit.al", "C.al"]);
    const display = displayPathsOf(flatNamesSidecar(n.renamed));
    const flat = n.flatOf("Sales/Helper.Codeunit.al");
    expect(display(flat)).toBe("Sales/Helper.Codeunit.al");
    expect(display(`/tmp/batch/${flat}`)).toBe("Sales/Helper.Codeunit.al");
    expect(display("C.al")).toBe("C.al");
    expect(displayPathsOf(undefined)(flat)).toBe(flat);
    expect(() => displayPathsOf("[1]")).toThrow(`${FLAT_NAMES_FILENAME} is not an object`);
  });
});
