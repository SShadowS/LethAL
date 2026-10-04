import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import * as schemata from "@lethal/schemata";
import { writeInstrumentedProject } from "@lethal/schemata";
import { buildExcludedSites } from "../src/excluded-sites";
import { generateMutationSet, identityOrdinalsOf, operatorTiers } from "../src/orchestrator";

/**
 * R307 Task 4: one test per refusal shape. Each asserts the exact refused row, that the good file
 * still writes, that no manifest row names the bad file, and that no source line of the refused
 * file reaches `detail`. Hand-written AL only.
 */

const APP_JSON = JSON.stringify({
  id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  name: "T",
  publisher: "P",
  version: "1.0.0.0",
  idRanges: [{ from: 50000, to: 79999 }],
});

/** Procedure body with three sites: empty-block, remove-assignment, shift-integer. */
const BODY = `{
    procedure Compute()
    var
        Counter: Integer;
    begin
        Counter := 1;
    end;
}
`;

const GOOD_AL = `codeunit 79301 "Good"\n${BODY}`;

const BAD: Record<string, { source: string; kinds: string; shape: string; detail: string }> = {
  mix: {
    source: `table 79310 "Mixed Table"
{
    fields { field(1; Code; Code[20]) { } }
}

enum 79311 "Mixed Enum"
{
    value(0; Zero) { }
}

codeunit 79312 "Mixed Code"
${BODY}`,
    kinds: "table_declaration, enum_declaration, codeunit_declaration",
    shape: "object-mix",
    detail:
      'an object that can carry the selector var shares the file with one that cannot; objects table:79310 "Mixed Table", enum:79311 "Mixed Enum", codeunit:79312 "Mixed Code"',
  },
  injector: {
    source: `codeunit 79320 "Plain Part"
${BODY}
#if not SYM
codeunit 79321 "Split Part" implements IFirst
#else
codeunit 79321 "Split Part" implements ISecond
#endif
${BODY}`,
    kinds: "codeunit_declaration, preproc_split_declaration",
    shape: "unsupported-kind",
    detail:
      'a mutation guard sits in an object that cannot carry the selector var; objects preproc_split:79321 "Split Part"; lines 20-22',
  },
  noHeader: {
    source: `namespace Demo; codeunit 50100 "Alone"\n${BODY}`,
    kinds: "namespace_declaration, codeunit_declaration",
    shape: "no-header",
    detail: "the object header rule found no object header",
  },
  siteBeforeHeader: {
    source: `namespace Demo; codeunit 50100 "First"\n${BODY}\ncodeunit 50101 "Second"\n{\n}\n`,
    kinds: "namespace_declaration, codeunit_declaration",
    shape: "site-before-header",
    detail: "a mutation site sits before the first object header the header rule found; lines 6-8",
  },
};

// Report paths are always "/"-separated (targetAlFiles normalises them), so never `join` these (R448).
const GOOD = "src/Good.Codeunit.al";
const BADFILE = "src/Bad.al";

beforeAll(async () => {
  await initParser();
});

async function withProject(bad: string, body: (projectDir: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "lethal-skip-"));
  const projectDir = join(root, "app");
  await Bun.write(join(projectDir, "app.json"), APP_JSON);
  await Bun.write(join(projectDir, GOOD), GOOD_AL);
  await Bun.write(join(projectDir, BADFILE), bad);
  try {
    await body(projectDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Trimmed source lines longer than 12 characters: none may appear in a `detail`. */
function longLines(source: string): string[] {
  return source
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 12);
}

async function writeAndReadManifest(set: Awaited<ReturnType<typeof generateMutationSet>>) {
  const out = await mkdtemp(join(tmpdir(), "lethal-skip-out-"));
  try {
    await writeInstrumentedProject({
      targetDir: out,
      files: set.files,
      selectorIds: { selectorId: 60000, controlId: 60001, tableId: 60002 },
      artifactId: "0123456789abcdef0123456789abcdef",
      targetAppId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      operatorTiers,
      identityOrdinals: identityOrdinalsOf(set),
    });
    return {
      written: (await readdir(out)).sort(),
      manifest: await readFile(join(out, "mutant-manifest.json"), "utf8"),
    };
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

describe("R307: one refused row per shape, the rest of the run intact", () => {
  for (const [name, bad] of Object.entries(BAD)) {
    test(name, () =>
      withProject(bad.source, async (projectDir) => {
        const set = await generateMutationSet(projectDir, { emit: () => {} });
        expect(set.files.map((f) => f.path)).toEqual([GOOD]);
        expect(set.refusedFiles.map((r) => [r.file, r.shape])).toEqual([[BADFILE, bad.shape]]);

        const excluded = buildExcludedSites({
          skipped: set.skipped,
          declarative: set.declarativeSites,
          preproc: set.preprocExcluded,
          refused: set.refusedFiles,
          totalFiles: set.totalFiles,
        });
        expect(excluded.files).toEqual([
          {
            file: BADFILE,
            kinds: bad.kinds,
            sites: name === "injector" ? 6 : 3,
            reason: "instrumentation-refused",
            // R307 T6: a header-rule refusal reserves no exact entry, and its BODY is a loose twin
            // of the good file's three sites, so their cross-run carry is disabled and counted.
            detail: `${bad.shape} in ${BADFILE}: ${bad.detail}${
              name === "noHeader" || name === "siteBeforeHeader"
                ? "; identity carry disabled for 3 mutant(s)"
                : ""
            }`,
          },
        ]);
        const detail = excluded.files[0]?.detail ?? "";
        for (const line of longLines(bad.source)) expect(detail).not.toContain(line);

        // The good file is written; nothing in the manifest names the bad one.
        const { written, manifest } = await writeAndReadManifest(set);
        expect(written).toContain("Good.Codeunit.al");
        expect(written).not.toContain("Bad.al");
        expect(manifest).toContain("Good.Codeunit.al");
        expect(manifest).not.toContain("Bad.al");
      }));
  }

  test("an unforeseen plain Error from the trial propagates and makes no row", async () => {
    const spy = spyOn(schemata, "planOneFile").mockImplementation(() => {
      throw new Error("an unforeseen instrumenter bug");
    });
    try {
      await withProject(BAD.mix?.source ?? "", async (projectDir) => {
        await expect(generateMutationSet(projectDir, { emit: () => {} })).rejects.toThrow(
          "an unforeseen instrumenter bug",
        );
      });
    } finally {
      spy.mockRestore();
    }
  });
});
