import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileSchemataForFile, reachLatchRefusedOwner } from "@lethal/schemata";
import { REACH_LATCH } from "../../schemata/src/reach-latch";
import { generateMutationSet } from "../src/orchestrator";

/**
 * R877. tree-sitter-al 4.6.0 (#32) parses a trigger whose header AND `var` section are both split
 * by `#if` as one `preproc_split_trigger_preamble` node. The writer's owner walk does not know that
 * node, so a statement-grain reach marker in its body would find no owner and refuse the whole file
 * (`compile.latch-owner`). MEASURED: no operator reaches the form. Every walk that picks sites
 * (`inMemberBody`, `isProcedureLike`, `enclosingStatement`) is blind to a body that hangs off that
 * node, so it gets NO mutant at all, and the file is neither refused nor skipped. The rest of the
 * file is mutated as usual. These tests pin that, so a grammar or walk change that makes the shape
 * produce a mutant turns this red and forces the latch walk to learn the node first.
 */

const APP_JSON = JSON.stringify({
  id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  name: "T",
  publisher: "P",
  version: "1.0.0.0",
  idRanges: [{ from: 79300, to: 79399 }],
});

/** Sites the operators would find: assignments, an `if`, a call, a literal, a boolean, a loop. */
const BODY = `    begin
        K := 1;
        Plain(K);
        if K > 0 then
            Message('x');
        K := K + 5;
        Flag := true;
        while K < 10 do begin
            K := K + 1;
            if Flag then begin
                Message('y');
            end;
        end;
    end;`;

const SPLIT_HEADER = (name: string, withElse: boolean): string =>
  withElse
    ? `#if C
    trigger ${name}
    var K: Integer; Flag: Boolean;
#else
    trigger ${name}
    var M: Integer; K: Integer; Flag: Boolean;
#endif
${BODY}`
    : `#if C
    trigger ${name}
    var K: Integer; Flag: Boolean;
#endif
${BODY}`;

/** A plain procedure: the control, in the same file, that must keep its mutants. */
const CONTROL = `
    procedure Plain(N: Integer): Integer
    begin
        if N > 10 then
            exit(1);
        exit(0);
    end;`;

const SHAPES: Record<string, string> = {
  "codeunit OnRun, #if/#else": `codeunit 79301 "S1"
{
${SPLIT_HEADER("OnRun()", true)}
${CONTROL}
}
`,
  "codeunit OnRun, #if without #else": `codeunit 79302 "S2"
{
${SPLIT_HEADER("OnRun()", false)}
${CONTROL}
}
`,
  "table OnInsert": `table 79303 "S3"
{
    fields { field(1; "No."; Code[20]) { } }
${SPLIT_HEADER("OnInsert()", true)}
${CONTROL}
}
`,
  "page OnAfterGetRecord": `page 79304 "S4"
{
    PageType = Card;
    SourceTable = Integer;
${SPLIT_HEADER("OnAfterGetRecord()", true)}
${CONTROL}
}
`,
  "table field OnValidate": `table 79305 "S5"
{
    fields
    {
        field(1; "No."; Code[20])
        {
${SPLIT_HEADER("OnValidate()", true)}
        }
    }
${CONTROL}
}
`,
};

interface Measured {
  /** Sites inside the split trigger (they are mutated; only their reach latch is refused). */
  readonly inTrigger: number;
  /** Sites elsewhere in the file (the plain procedure). */
  readonly elsewhere: number;
  readonly refused: number;
  readonly skipped: number;
  readonly warnings: readonly string[];
  /** `compileSchemataForFile` output for the file. */
  readonly out: string;
}

async function measure(source: string, operators?: readonly string[]): Promise<Measured> {
  const root = await mkdtemp(join(tmpdir(), "lethal-r877-"));
  const dir = join(root, "app");
  try {
    await Bun.write(join(dir, "app.json"), APP_JSON);
    await Bun.write(join(dir, "Al/Probe.al"), source);
    const warnings: string[] = [];
    const emit = (e: { type: string; message?: string }): void => {
      if (e.type === "warning" && e.message?.includes("reach-latch") !== undefined)
        warnings.push(e.message ?? "");
    };
    const set = await generateMutationSet(dir, {
      ...(operators !== undefined ? { operators } : {}),
      emit: emit as never,
    });
    const [file] = set.files;
    if (file === undefined) throw new Error("no instrumented file");
    const inTrigger = file.specs.filter((s) => reachLatchRefusedOwner(s.before) !== null).length;
    return {
      inTrigger,
      elsewhere: file.specs.length - inTrigger,
      refused: set.refusedFiles.length,
      skipped: set.skipped.length,
      warnings,
      out: compileSchemataForFile(file.source, file.root, file.specs),
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("R877: a #if-split trigger preamble", () => {
  for (const [name, source] of Object.entries(SHAPES)) {
    test(`${name}: the member is refused by name, the file is instrumented`, async () => {
      for (const operators of [undefined, ["lethal.condition-true"], ["lethal.blank-argument"]]) {
        // blank-argument matches no site in this fixture (measured), and the run refuses by name.
        const m = await measure(source, operators).catch((e: unknown) => {
          if (operators?.[0] === "lethal.blank-argument" && String(e).includes("matched no"))
            return null;
          throw e;
        });
        if (m === null) continue;
        console.log(
          `R877 ${name} [${operators?.join() ?? "default"}]: in trigger ${m.inTrigger}, elsewhere ${m.elsewhere}`,
        );
        expect(m.refused).toBe(0);
        expect(m.skipped).toBe(0);
        if (operators === undefined) {
          // The trigger's sites exist, the control's too, and only the trigger is named.
          expect(m.inTrigger).toBeGreaterThan(0);
          expect(m.elsewhere).toBeGreaterThan(0);
          expect(m.warnings).toHaveLength(1);
          expect(m.warnings[0]).toContain("preproc_split_trigger_preamble");
          expect(m.warnings[0]).toContain(`${m.inTrigger} site(s)`);
          // No latch anywhere in the trigger; the plain procedure takes the one latch.
          expect(m.out.split(`var ${REACH_LATCH}: Boolean;`).length - 1).toBe(1);
          expect(m.out.indexOf(REACH_LATCH)).toBeGreaterThan(m.out.indexOf("procedure Plain"));
        }
      }
    });
  }
});
