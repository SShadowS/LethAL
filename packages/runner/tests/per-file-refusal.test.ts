import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import * as schemata from "@lethal/schemata";
import { writeInstrumentedProject } from "@lethal/schemata";
import { generateMutationSet, identityOrdinalsOf, operatorTiers } from "../src/orchestrator";

/**
 * R307 Task 3: `generateMutationSet` runs the writer's own per-file steps (`instrumentOneFile`) as
 * a trial, and a `FileRefusedError` refuses THAT file whole instead of aborting the run.
 */

const APP_JSON = JSON.stringify({
  id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  name: "T",
  publisher: "P",
  version: "1.0.0.0",
  idRanges: [{ from: 79300, to: 79399 }],
});

/** Measured sites: empty-block, remove-assignment, shift-integer. */
const GOOD_AL = `codeunit 79301 "Good"
{
    procedure P()
    var
        X: Integer;
    begin
        X := 1;
    end;
}
`;

/** A codeunit and a page in one file: refused as `object-mix`. Its codeunit holds the project's
 *  only `exit(true)`, so `flip-boolean-literal` finds sites here and nowhere else. */
const MIXED_AL = `codeunit 79302 "Mixed"
{
    procedure Q(): Boolean
    begin
        exit(true);
    end;
}

page 79303 "Mixed Page"
{
    PageType = Card;
    layout { area(Content) { } }
}
`;

/** An unquoted non-ASCII object name: tree-sitter parses the codeunit, the header regex's `\w`
 *  does not match it, so the header rule refuses the file as `no-header`. */
const NO_HEADER_AL = `codeunit 79305 Ærø
{
    procedure R()
    var
        Y: Integer;
    begin
        Y := 2;
    end;
}
`;

/** Holds code but is not a carrier kind, so it is skipped (not refused). Its `SetRange` is a
 *  `void-method-call` site, a shape `Mixed.al` does not hold. */
const XMLPORT_AL = `xmlport 79306 "Only Xmlport"
{
    schema
    {
        textelement(Root)
        {
            trigger OnBeforePassVariable()
            var
                Other: Record "Other Table";
            begin
                Other.SetRange("No.", 'A');
            end;
        }
    }
}
`;

async function withProject(
  files: Readonly<Record<string, string>>,
  body: (projectDir: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "lethal-refusal-"));
  const projectDir = join(root, "app");
  await Bun.write(join(projectDir, "app.json"), APP_JSON);
  for (const [rel, content] of Object.entries(files)) {
    await Bun.write(join(projectDir, rel), content);
  }
  try {
    await body(projectDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// Report paths are always "/"-separated (targetAlFiles normalises them), so never `join` these (R448).
const GOOD = "src/Good.Codeunit.al";
const MIXED = "src/Mixed.al";
const NO_HEADER = "src/Odd.al";
const XMLPORT = "src/Only.XmlPort.al";

beforeAll(async () => {
  await initParser();
});

describe("R307: the per-file trial", () => {
  test("refuses a bad file whole and keeps the rest of the run", () =>
    withProject(
      { [GOOD]: GOOD_AL, [MIXED]: MIXED_AL, [NO_HEADER]: NO_HEADER_AL },
      async (projectDir) => {
        const set = await generateMutationSet(projectDir, { emit: () => {} });
        expect(set.files.map((f) => f.path)).toEqual([GOOD]);
        expect(set.refusedFiles.map((r) => [r.file, r.shape, r.sites])).toEqual([
          [MIXED, "object-mix", 3],
          [NO_HEADER, "no-header", 3],
        ]);
        const [mixed, noHeader] = set.refusedFiles;
        expect(mixed?.objects).toEqual([
          { type: "codeunit", id: 79302, name: "Mixed" },
          { type: "page", id: 79303, name: "Mixed Page" },
        ]);
        // Exact refusal: its sites are RESERVED in the run-wide numbering, so no coarse tuples.
        expect(mixed?.coarseTuples).toBeUndefined();
        // Header refusal: no object name to reserve under, so coarse tuples (R442) instead (fail
        // closed): hash, operator and major, no name and no scope.
        expect(noHeader?.coarseTuples).toHaveLength(3);
        for (const t of noHeader?.coarseTuples ?? [])
          expect(t).toMatch(/^[0-9a-f]{64}\|lethal\.[a-z-]+\|1$/);
        // 3 deployed + 3 reserved; the no-header file takes no number.
        expect(identityOrdinalsOf(set).size).toBe(6);
        const reserved = [...identityOrdinalsOf(set).keys()].filter((k) =>
          k.startsWith(`${MIXED}\0`),
        );
        expect(reserved).toHaveLength(3);
        expect(
          [...identityOrdinalsOf(set).keys()].some((k) => k.startsWith(`${NO_HEADER}\0`)),
        ).toBe(false);
      },
    ));

  test("I4: an operator whose only sites are in a refused file is refused by name", () =>
    withProject({ [GOOD]: GOOD_AL, [MIXED]: MIXED_AL }, async (projectDir) => {
      const err = await generateMutationSet(projectDir, {
        operators: ["remove-assignment", "flip-boolean-literal"],
        emit: () => {},
      }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      const message = err instanceof Error ? err.message : "";
      expect(message).toContain("no deployable mutation site");
      expect(message).toContain('"lethal.flip-boolean-literal"');
      expect(message).not.toContain('"lethal.remove-assignment"');
      // The refused file is named in the message itself: the run stops here, before the
      // instrumentation-refused-files warning or any report could name it.
      expect(message).toContain(
        `"lethal.flip-boolean-literal" DID find sites, but only in files refused whole at instrumentation (R307): ${MIXED} (object-mix), so nothing would deploy.`,
      );
      // No not-instrumentable file held its sites, so the skip list is not offered as the reason.
      expect(message).not.toContain("no selector var can be injected into");
    }));

  test("I4: a refused file holding none of the barren operator's sites is not named", () =>
    withProject(
      { [GOOD]: GOOD_AL, [MIXED]: MIXED_AL, [XMLPORT]: XMLPORT_AL },
      async (projectDir) => {
        // Mixed.al IS refused under this selection: its empty-block site reaches the trial.
        const control = await generateMutationSet(projectDir, {
          operators: ["empty-block"],
          emit: () => {},
        });
        expect(control.refusedFiles.map((r) => r.file)).toEqual([MIXED]);
        const err = await generateMutationSet(projectDir, {
          operators: ["empty-block", "void-method-call"],
          emit: () => {},
        }).then(
          () => undefined,
          (e: unknown) => e,
        );
        const message = err instanceof Error ? err.message : "";
        expect(message).toContain(
          `"lethal.void-method-call" DID find sites, but only in files no selector var can be injected into (see the skip list above), so nothing would deploy.`,
        );
        expect(message).not.toContain("refused whole");
      },
    ));

  test("a non-FileRefusedError thrown inside the trial still aborts the run", async () => {
    const spy = spyOn(schemata, "planOneFile").mockImplementation(() => {
      throw new Error("an unforeseen instrumenter bug");
    });
    try {
      await withProject({ [GOOD]: GOOD_AL }, async (projectDir) => {
        await expect(generateMutationSet(projectDir, { emit: () => {} })).rejects.toThrow(
          "an unforeseen instrumenter bug",
        );
      });
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

/**
 * The trial changes nothing for a project with no refused file: `fixtures/sandbox-data`'s manifest
 * and every instrumented file are byte-identical to the output of HEAD d1438ade (before the trial
 * existed), measured with this same write.
 *
 * Since R421 every platform writes a discovered path in the one `/` form, so this pin is the one
 * value valid on Windows and Linux alike. It was the Windows capture before (manifest b03f52f2...,
 * all files e889a463...), which no Linux run ever matched; the values below are the ones Linux
 * gave all along, re-recorded deliberately. The identity scheme is not written into these files,
 * so the scheme 14, 16, 17 and 18 bumps do not move them. R281 re-pinned both (manifest was b754095f...588e, all
 * files 9abd8f06...73c6): `DeleteWithTrigger`'s mutant gained `run-trigger-skipped-delete`.
 * R-457 re-pinned both (manifest was 5e997a85...5e4e, all files da7243c9...bd74): seven mutants
 * gained `run-trigger-forced`, the manifest's only change.
 * R254 re-pinned both (manifest was db3667dd...a82f, all files daa98b9f...7a07): the
 * reportextension arm (`DataBandExt.ReportExt.al`, 15 mutants) is instrumented, and every later
 * mutant id moves by 15.
 */
describe("R307: sandbox-data is byte-identical with the trial in place", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "lethal-r307-pin-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  test("manifest and instrumented files", async () => {
    const REPO = join(import.meta.dir, "../../..");
    const set = await generateMutationSet(join(REPO, "fixtures/sandbox-data"), { emit: () => {} });
    expect(set.refusedFiles).toEqual([]);
    await writeInstrumentedProject({
      targetDir: dir,
      files: set.files,
      selectorIds: { selectorId: 60000, controlId: 60001, tableId: 60002 },
      artifactId: "0123456789abcdef0123456789abcdef",
      targetAppId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      operatorTiers,
      identityOrdinals: identityOrdinalsOf(set),
    });
    const manifest = await readFile(join(dir, "mutant-manifest.json"));
    expect(createHash("sha256").update(manifest).digest("hex")).toBe(
      // R459: flip-boolean-literal's operatorVersion 1.1.0 is the only change (was b1d589cd...5e21).
      // R474: every entry gains `memberHash`, the only change (was 105d129b...b83f).
      // R477: validate-to-assign's operatorVersion 1.2.0 is the only change (was db5aef54...b4e7).
      // R276: `gapId` values only, the gap partition unchanged (was 59942c7a...4e81).
      "c83bdd08f26dcfe93030f9b5b6c354ea05ba5068279866c4f59a2f51dced23eb",
    );
    const all = createHash("sha256");
    for (const f of (await readdir(dir)).sort()) {
      all.update(f);
      all.update(await readFile(join(dir, f)));
    }
    // R470: re-pinned (was dec43213...a617) for DataBandExt's selector var `MutationSelector79341`;
    // the manifest pin above is unchanged by R470. R459 (merged over R470): the manifest's 13 flip
    // entries carry operatorVersion 1.1.0, so this moved again (R470 alone gave 4dfb9b56...a329).
    // R474: the manifest's `memberHash` alone moved it (was 4fb14bca...b9e6; the same files with
    // that key removed from the manifest give 4fb14bca...b9e6 again).
    // R477: only the manifest moved it, by validate-to-assign's operatorVersion 1.2.0 (was
    // e166345f...1358, which the same tree at 1.1.0 still gives).
    // R276: only the manifest moved it, by its `gapId` values (was 3e3a8ec9...f6ae); gap ids are not
    // in the instrumented AL.
    expect(all.digest("hex")).toBe(
      "d77b17a3a9eb414d1376632e5dfb2cd51ff2080982e675cfb078b914fac749ea",
    );
  }, 60_000);
});
