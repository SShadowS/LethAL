import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AlRunnerCoverageFrameError,
  alRunnerCoverageFromServer,
  buildAlRunnerCoverageIndex,
} from "../src/al-runner-coverage";
import { removeRunScratchAfterAll, scratchDirs } from "./helpers/scratch";

/**
 * R407 P5: the coverage index's label backstop, which the kept al-runner coverage index still
 * applies (`assertAdmittedLabel`). R654 S3 removed the rest of this file with the .NET al-runner:
 * the CLI coverage guard and frame probe (P3), the backend's own backstops, and the one-shot
 * Cobertura half of each case below (`alRunnerCoverageFrom`). The `perTestCoverage` half stays.
 */

const scratch = scratchDirs();
removeRunScratchAfterAll();

const PAIR_FILE = "Pair.Codeunit.al";
/** Two codeunits in one file: P (lines 1-7, `exit;` at 5) then Q (8-14, `exit;` at 12). */
const PAIR = `codeunit 50104 P
{
    procedure Run()
    begin
        exit;
    end;
}
codeunit 50105 Q
{
    procedure Run()
    begin
        exit;
    end;
}
`;
const SINGLE = `codeunit 50106 S
{
    procedure Run()
    begin
        exit;
    end;
}
`;

describe("R407 P5: the label backstop, each label shape (index level)", () => {
  /** `<root>/inst/active` holds the file; `<root>/src` and `<root>/inst/batch-1` are siblings. */
  async function rooted(text: string) {
    const root = scratch("lethal-r407-labels-");
    const bundle = join(root, "inst", "active");
    await mkdir(bundle, { recursive: true });
    await writeFile(join(bundle, PAIR_FILE), text, "utf8");
    const index = await buildAlRunnerCoverageIndex(bundle, { labelBase: root });
    return { root, index };
  }
  const server = (file: string) => ({
    test: "Codeunit1.T",
    coverage: [{ file, statements: [{ line: 12, hits: 1, scope: "Run" }] }],
  });
  const outside: [string, (root: string) => string][] = [
    ["a relative SOURCE label", () => `src/${PAIR_FILE}`],
    ["a relative BATCH-SIBLING label", () => `inst/batch-1/${PAIR_FILE}`],
    ["an absolute SOURCE label", (root) => join(root, "src", PAIR_FILE)],
    ["an absolute BATCH-SIBLING label", (root) => join(root, "inst", "batch-1", PAIR_FILE)],
    ["a look-alike folder (active-old)", (root) => join(root, "inst", "active-old", PAIR_FILE)],
  ];
  for (const [name, labelOf] of outside) {
    test(`${name} on an admitted multi-object file throws`, async () => {
      const { root, index } = await rooted(PAIR);
      expect(() => alRunnerCoverageFromServer(server(labelOf(root)), index)).toThrow(
        AlRunnerCoverageFrameError,
      );
    });
    test(`${name} on a SINGLE-object file does not throw (unchanged)`, async () => {
      const { root, index } = await rooted(SINGLE);
      expect(() => alRunnerCoverageFromServer(server(labelOf(root)), index)).not.toThrow();
    });
  }
  test("an absolute label INSIDE the bundle resolves to Q.Run", async () => {
    const { root, index } = await rooted(PAIR);
    const want = [{ objectType: "Codeunit", objectId: 50105, procedure: "Run", line: 5 }];
    const abs = join(root, "inst", "active", PAIR_FILE);
    expect(alRunnerCoverageFromServer(server(abs), index).entries).toEqual(want);
  });
});
