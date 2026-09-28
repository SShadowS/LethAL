import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UPSTREAM_LICENSES, licenseTexts, spdxAllowed } from "./native-notices";

describe("spdxAllowed", () => {
  const cases: [string, boolean][] = [
    ["MIT", true],
    ["MIT OR Apache-2.0", true],
    ["MIT/Apache-2.0", true],
    ["MIT OR GPL-3.0-only", true],
    ["MIT AND GPL-3.0-only", false],
    ["(MIT OR Apache-2.0) AND Unicode-3.0", true],
    ["(MIT OR GPL-3.0-only) AND GPL-2.0-only", false],
    ["Apache-2.0 WITH LLVM-exception", true],
    ["GPL-2.0-only WITH Classpath-exception-2.0", false],
    ["", false],
  ];
  for (const [expr, want] of cases)
    it(`${expr || "(empty)"} -> ${want}`, () => expect(spdxAllowed(expr)).toBe(want));
  it("throws on an unbalanced expression", () =>
    expect(() => spdxAllowed("(MIT OR Apache-2.0")).toThrow());
});

describe("licenseTexts", () => {
  const root = mkdtempSync(join(tmpdir(), "notices-"));
  const pkg = (name: string, files: Record<string, string>) => {
    const d = join(root, name);
    mkdirSync(d, { recursive: true });
    for (const [f, t] of Object.entries(files)) writeFileSync(join(d, f), t);
    return d;
  };
  const licenses = pkg("licenses", { "tree-sitter.LICENSE": "MIT\r\nCopyright (c) Upstream\r\n" });

  it("reads every packaged license, copyright and notice file, CR stripped", () =>
    expect(
      licenseTexts(
        "x",
        "1.0.0",
        pkg("x", { "LICENSE-MIT": "MIT\r\n", COPYRIGHT: "(c) X\n", "README.md": "no" }),
        licenses,
      ),
    ).toEqual([
      { origin: "COPYRIGHT", text: "(c) X" },
      { origin: "LICENSE-MIT", text: "MIT" },
    ]));
  it("falls back to the committed upstream copy when the crate packages none", () =>
    expect(licenseTexts("tree-sitter", "0.25.10", pkg("ts", { "lib.rs": "" }), licenses)).toEqual([
      {
        origin: `upstream ${UPSTREAM_LICENSES["tree-sitter@0.25.10"]?.source}`,
        text: "MIT\nCopyright (c) Upstream",
      },
    ]));
  it("refuses a known crate at a version whose text was not re-copied", () =>
    expect(() =>
      licenseTexts("tree-sitter", "0.26.0", pkg("ts2", { "lib.rs": "" }), licenses),
    ).toThrow(/tree-sitter 0\.26\.0 packages no license file/));
  it("refuses a crate with no license text anywhere", () =>
    expect(() => licenseTexts("bare", "1.0.0", pkg("bare", { "lib.rs": "" }), licenses)).toThrow(
      /packages no license file/,
    ));
});
