import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownTimeout } from "@lethal/engine/own-timeout";
import { generateMutationSet } from "../src/orchestrator";
import { removeRunScratchAfterAll } from "./helpers/scratch";

removeRunScratchAfterAll();

/**
 * R856 review fixes: the dispatch hang rule `clockSwapHangs`, one procedure per case. Each case
 * lists the swaps that survive the rule; a refused site is absent from the list.
 */
const NAME = "lethal.swap-workdate-today";

const APP_JSON = JSON.stringify({
  id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeef",
  name: "T",
  publisher: "P",
  version: "1.0.0.0",
  idRanges: [{ from: 79400, to: 79499 }],
});

async function swapsOf(body: string): Promise<string[]> {
  const root = await mkdtemp(join(tmpdir(), "lethal-r856h-"));
  const dir = join(root, "app");
  try {
    await Bun.write(join(dir, "app.json"), APP_JSON);
    // A first procedure that always keeps its site, so a case where every site is refused does not
    // make the run throw. Its spec is dropped below, by position.
    const keep = `codeunit 79430 "Clock"\n{\nprocedure Keep(): Date begin exit(WorkDate()); end;\n`;
    await Bun.write(join(dir, "Al/Clock.Codeunit.al"), `${keep}${body}\n}\n`);
    const set = await generateMutationSet(dir, { operators: [NAME] });
    return set.files
      .flatMap((f) => f.specs)
      .filter((s) => s.operatorName === NAME && s.before.startIndex >= keep.length)
      .map((s) => `${s.before.text} -> ${s.after.text}`)
      .sort();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("R856: clockSwapHangs", () => {
  test(
    "a clock site anywhere in a repeat whose until reads the clock is refused (the setter is in the body)",
    async () => {
      // Only the getter in the CalcDate argument is a candidate besides the `until` one: both go.
      expect(
        await swapsOf(`procedure P()
    var
        D: Date;
        E: Date;
    begin
        repeat
            D := CalcDate('<1D>', WorkDate());
            WorkDate(D);
        until WorkDate() > E;
    end;`),
      ).toEqual([]);
    },
    ownTimeout(60_000),
  );

  test(
    "the same in a while loop",
    async () => {
      expect(
        await swapsOf(`procedure P()
    var
        D: Date;
        E: Date;
    begin
        while WorkDate() < E do begin
            D := CalcDate('<1D>', Today());
            WorkDate(D);
        end;
    end;`),
      ).toEqual([]);
    },
    ownTimeout(60_000),
  );

  test(
    "control: a clock site in a loop whose exit reads no clock stays claimed",
    async () => {
      expect(
        await swapsOf(`procedure P()
    var
        Stamp: Date;
        I: Integer;
    begin
        repeat
            Stamp := WorkDate();
            I += 1;
        until I > 3;
    end;`),
      ).toEqual(["WorkDate() -> Today()"]);
    },
    ownTimeout(60_000),
  );

  test(
    "named limit: a setter in a helper is outside the loop, so a claimed site in the helper is kept",
    async () => {
      expect(
        await swapsOf(`procedure P()
    var
        E: Date;
    begin
        repeat
            AdvanceHelper();
        until WorkDate() > E;
    end;

    procedure AdvanceHelper()
    begin
        WorkDate(CalcDate('<1D>', WorkDate()));
    end;`),
      ).toEqual(["WorkDate() -> Today()"]);
    },
    ownTimeout(60_000),
  );

  // hangCapableForMutatedNode is load-bearing in clockSwapHangs: these two are refused only by it.
  test(
    "a value that feeds a mixed cursor-or-compare exit is refused",
    async () => {
      expect(
        await swapsOf(`procedure P(var R: Record "Gen. Journal Line")
    var
        D: Date;
        E: Date;
    begin
        repeat
            D := Today();
        until (R.Next() = 0) or (D > E);
    end;`),
      ).toEqual([]);
    },
    ownTimeout(60_000),
  );

  test(
    "a value written to a for loop's control variable is refused",
    async () => {
      expect(
        await swapsOf(`procedure P(X: Integer)
    var
        I: Integer;
    begin
        for I := 1 to 10 do
            I := Today() - X;
    end;`),
      ).toEqual([]);
    },
    ownTimeout(60_000),
  );
});
