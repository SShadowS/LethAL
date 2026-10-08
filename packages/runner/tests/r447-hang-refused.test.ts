import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import type { RunEvent, RunEventInput } from "../src/events";
import { generateMutationSet } from "../src/orchestrator";
import { buildReport, renderConsole } from "../src/report";

/**
 * R447: R196 refuses a mutation that could make an enclosing loop never end. Those refusals are
 * now one `excludedSites` row per file (reason `hang-refused`, a site count), and a row with sites
 * narrows `reliability`, as R399's left-out rows do.
 */

const APP_JSON = JSON.stringify({
  id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  name: "T",
  publisher: "P",
  version: "1.0.0.0",
  idRanges: [{ from: 50000, to: 79999 }],
});
// Line 6, `Pending -= 1`, is R196's refused loop step: one remove-assignment site and one
// shift-integer site (its `1`). No other remove-assignment site exists in this file.
const HANG = "src/Hang.Codeunit.al";
const HANG_AL = `codeunit 50470 "Hang"
{
    procedure Drain(var Pending: Integer)
    begin
        while Pending > 0 do
            Pending -= 1;
    end;
}
`;
// No loop: no row. Line 7 holds a deployable remove-assignment and a conditional-boundary site.
const PLAIN = "src/Plain.Codeunit.al";
const PLAIN_AL = `codeunit 50471 "Plain"
{
    procedure Twice(X: Integer): Integer
    var
        Y: Integer;
    begin
        if X > 1 then Y := X + X;
        exit(Y);
    end;
}
`;
const HANG_IF = "src/HangIf.Codeunit.al";
// Only the loop STEP sits in the `#if`: the condition stays active, so the hang check alone still
// refuses the step, and only the generator's inactive-arm clause keeps it out of the count.
const HANG_IF_AL = `codeunit 50472 "HangIf"
{
    procedure Drain(var Pending: Integer)
    begin
        while Pending > 0 do begin
#if R447SYM
            Pending -= 1;
#endif
        end;
    end;
}
`;

const roots: string[] = [];
beforeAll(async () => {
  await initParser();
});
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});
async function project(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "lethal-r447-"));
  roots.push(root);
  await Bun.write(join(root, "app.json"), APP_JSON);
  for (const [rel, content] of Object.entries(files)) await Bun.write(join(root, rel), content);
  return root;
}
const ROW = (file: string, sites: number) => ({ file, kinds: "codeunit_declaration", sites });

describe("R447: generation", () => {
  test("(a) the loop step yields one row with 2 sites; a loop-free file yields none", async () => {
    const dir = await project({ [HANG]: HANG_AL, [PLAIN]: PLAIN_AL });
    const set = await generateMutationSet(dir, { emit: () => {} });
    expect(set.hangRefused).toEqual([ROW(HANG, 2)]);
  });

  test("(b) --operator naming an operator that never refuses for hang: no row", async () => {
    const dir = await project({ [HANG]: HANG_AL, [PLAIN]: PLAIN_AL });
    const set = await generateMutationSet(dir, {
      emit: () => {},
      operators: ["lethal.conditional-boundary"],
    });
    expect(set.files.map((f) => f.path)).toContain(PLAIN);
    expect(set.hangRefused).toEqual([]);
  });

  test("(c) a file whose only admitted-operator sites are hang-refused keeps its row", async () => {
    const dir = await project({ [HANG]: HANG_AL, [PLAIN]: PLAIN_AL });
    const set = await generateMutationSet(dir, {
      emit: () => {},
      operators: ["lethal.remove-assignment"],
    });
    expect(set.files.map((f) => f.path)).toEqual([PLAIN]);
    expect(set.hangRefused).toEqual([ROW(HANG, 1)]);
  });

  test("(d) a loop step in an inactive #if arm is compiled out, not refused", async () => {
    const dir = await project({ [HANG_IF]: HANG_IF_AL, [PLAIN]: PLAIN_AL });
    const off = await generateMutationSet(dir, { emit: () => {} });
    expect(off.hangRefused).toEqual([]);
    const on = await generateMutationSet(dir, {
      emit: () => {},
      preprocessorSymbols: ["R447SYM"],
    });
    expect(on.hangRefused).toEqual([ROW(HANG_IF, 2)]);
  });

  test("(e) --lines away from the loop step: no row; over it: the row", async () => {
    const dir = await project({ [HANG]: HANG_AL, [PLAIN]: PLAIN_AL });
    const plainLine = { file: PLAIN, start: 7, end: 7 };
    const away = await generateMutationSet(dir, {
      emit: () => {},
      lines: [plainLine, { file: HANG, start: 3, end: 3 }],
    });
    expect(away.hangRefused).toEqual([]);
    const over = await generateMutationSet(dir, {
      emit: () => {},
      lines: [plainLine, { file: HANG, start: 6, end: 6 }],
    });
    expect(over.hangRefused).toEqual([ROW(HANG, 2)]);
  });

  test("(f) an operator whose only sites are hang-refused: the barren error says so", async () => {
    const dir = await project({ [HANG]: HANG_AL });
    const err = await generateMutationSet(dir, {
      emit: () => {},
      operators: ["lethal.remove-assignment"],
    }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(
      `"lethal.remove-assignment" had site(s) refused as hang-capable (each writes a variable an enclosing loop's condition reads, R196, or is code of an unbounded report data item or a bounded item's only bound, R487/R501): ${HANG} (1)`,
    );
  });
});

const CAPS = {
  authoritative: true,
  coverage: "procedure",
  deploy: "publish",
  isolation: "session",
} as const;

function reportFor(hangRefusedFiles?: readonly ReturnType<typeof ROW>[], baselineRed = false) {
  const events: RunEvent[] = (
    [
      {
        type: "mutation-set-generated",
        siteCount: 3,
        deployedCount: 3,
        hangCapableCount: 0,
        totalFiles: 10,
        instrumentableFiles: 8,
        notInstrumentedFiles: [],
        declarativeSiteFiles: [],
        preprocExcludedFiles: [],
        excludedByOnly: 0,
        excludedByExclude: 0,
        excludedByOperator: 0,
        ...(hangRefusedFiles !== undefined ? { hangRefusedFiles } : {}),
      },
      {
        type: "baseline-batch-finished",
        batchIndex: 0,
        verdicts: baselineRed
          ? [{ name: "T.A", outcome: "fail", durationMs: 1, classification: [] }]
          : [],
      },
      { type: "session-finished", elapsedMs: 10 },
    ] as RunEventInput[]
  ).map((e, i) => ({ ...e, seq: i + 1 }) as RunEvent);
  return buildReport({ caps: CAPS, buildSymbols: [] }, events);
}

describe("R447: report", () => {
  const CLAUSE = "; 2 hang-refused site(s) in 1 file(s) not mutated";

  test("a row with sites -> narrowed, the scoreDescribes clause and the row itself", () => {
    const r = reportFor([ROW(HANG, 2)]);
    expect(r.validity.reliability).toBe("narrowed");
    expect(r.validity.scoreDescribes).toContain(CLAUSE);
    expect(r.excludedSites?.files).toEqual([{ ...ROW(HANG, 2), reason: "hang-refused" }]);
    expect(r.validity.caveats).toEqual([]);
    expect(renderConsole(r)).toContain(
      "HANG-REFUSED SITES: 2 site(s) in 1 file(s) could hang the run if mutated: each writes a variable an enclosing loop's condition reads (R196), or is code of an unbounded report data item or a bounded item's only bound (R487/R501). No mutant was made there. They are absent from every count above.",
    );
  });

  test("no row -> full, no clause", () => {
    for (const r of [reportFor(), reportFor([])]) {
      expect(r.validity.reliability).toBe("full");
      expect(r.validity.scoreDescribes).not.toContain("hang-refused");
      expect(renderConsole(r)).not.toContain("HANG-REFUSED");
    }
  });

  test("a zero-site row does not narrow", () => {
    const r = reportFor([ROW(HANG, 0)]);
    expect(r.validity.reliability).toBe("full");
    expect(r.validity.scoreDescribes).not.toContain("hang-refused");
  });

  test("with a red baseline: narrowed-degraded", () => {
    expect(reportFor([ROW(HANG, 2)], true).validity.reliability).toBe("narrowed-degraded");
    expect(reportFor(undefined, true).validity.reliability).toBe("degraded");
  });
});
