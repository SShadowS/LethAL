import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownTimeout } from "@lethal/engine/own-timeout";
import { admittedOperatorNames, generateMutationSet, operatorTiers } from "../src/orchestrator";
import { removeRunScratchAfterAll } from "./helpers/scratch";

removeRunScratchAfterAll();

/**
 * R856 (#33). `lethal.swap-workdate-today` is OPT-IN and its hang rule is read at the dispatch.
 *   - A default run, and one under `--exclude-operator`, never WALK it: no spec, no hang count.
 *   - `--operator` naming it walks it, alone or with others.
 *   - A site in a loop's exit parts, one a value reaches an exit from, and a getter inside a
 *     `WorkDate(...)` setter argument in a loop are refused and counted.
 */
const NAME = "lethal.swap-workdate-today";

const APP_JSON = JSON.stringify({
  id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  name: "T",
  publisher: "P",
  version: "1.0.0.0",
  idRanges: [{ from: 79300, to: 79399 }],
});

const AL = `codeunit 79330 "Clock"
{
    procedure Plain(): Date
    begin
        exit(WorkDate());
    end;

    procedure InExit()
    var
        E: Date;
    begin
        while WorkDate() < E do
            E := CalcDate('<-1D>', E);
    end;

    procedure InRepeatExit()
    var
        E: Date;
    begin
        repeat
            E := CalcDate('<1D>', E);
        until Today() > E;
    end;

    procedure InSetterArgument()
    var
        E: Date;
    begin
        repeat
            WorkDate(CalcDate('<1D>', WorkDate()));
        until E < 20300101D;
    end;

    procedure InSetterArgumentNoLoop()
    begin
        WorkDate(CalcDate('<1D>', WorkDate()));
    end;

    procedure FeedsExit()
    var
        Stamp: Date;
        E: Date;
    begin
        repeat
            Stamp := Today();
            E := CalcDate('<1D>', E);
        until E > Stamp;
    end;

    procedure PreLoopDeadline()
    var
        Stamp: Date;
        E: Date;
    begin
        Stamp := Today();
        repeat
            E := CalcDate('<1D>', E);
        until E > Stamp;
    end;
}
`;

async function withProject(body: (dir: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "lethal-r856-"));
  const dir = join(root, "app");
  await Bun.write(join(dir, "app.json"), APP_JSON);
  await Bun.write(join(dir, "Al/Clock.Codeunit.al"), AL);
  try {
    await body(dir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const swaps = (set: Awaited<ReturnType<typeof generateMutationSet>>): string[] =>
  set.files
    .flatMap((f) => f.specs)
    .filter((s) => s.operatorName === NAME)
    .map((s) => `${s.before.text} -> ${s.after.text}`)
    .sort();

describe("R856: the opt-in operator", () => {
  test("operatorTiers knows it", () => {
    expect(operatorTiers.get(NAME)).toBe(2);
  });

  test(
    "a default run walks it not at all: no spec, no hang count",
    async () => {
      await withProject(async (dir) => {
        const set = await generateMutationSet(dir);
        expect(swaps(set)).toEqual([]);
        // Equal to a run that excludes it by name: specs and hang counts.
        const named = await generateMutationSet(dir, { excludeOperators: [NAME] });
        expect(set.files.map((f) => f.specs.map((s) => s.after.text))).toEqual(
          named.files.map((f) => f.specs.map((s) => s.after.text)),
        );
        expect(set.hangRefused).toEqual(named.hangRefused);
      });
    },
    ownTimeout(60_000),
  );

  test(
    "--exclude-operator on another operator still leaves it out",
    async () => {
      await withProject(async (dir) => {
        const set = await generateMutationSet(dir, {
          excludeOperators: ["lethal.empty-block"],
        });
        expect(swaps(set)).toEqual([]);
        const named = await generateMutationSet(dir, {
          excludeOperators: ["lethal.empty-block", NAME],
        });
        expect(set.hangRefused).toEqual(named.hangRefused);
      });
    },
    ownTimeout(60_000),
  );

  test("admittedOperatorNames: exclusion never admits it, naming it does", () => {
    const registered = [...operatorTiers.keys()];
    expect(admittedOperatorNames({}, registered)).toBeUndefined();
    expect(
      admittedOperatorNames({ excludeOperators: ["lethal.empty-block"] }, registered)?.has(NAME),
    ).toBe(false);
    expect([
      ...(admittedOperatorNames({ operators: ["swap-workdate-today"] }, registered) ?? []),
    ]).toEqual([NAME]);
  });

  test(
    "--operator naming it alone: the plain getter, and nothing in a loop's exit",
    async () => {
      await withProject(async (dir) => {
        const set = await generateMutationSet(dir, { operators: [NAME] });
        // Plain, and the setter-argument getter outside any loop. The setter itself is not a site.
        // Plain, the setter argument outside a loop, and the named limit: a deadline set before a loop.
        expect(swaps(set)).toEqual([
          "Today() -> WorkDate()",
          "WorkDate() -> Today()",
          "WorkDate() -> Today()",
        ]);
        // InExit (WorkDate in the condition), InRepeatExit (Today in `until`), InSetterArgument
        // (getter in a setter argument in a loop), FeedsExit (the value reaches the exit).
        const refused = set.hangRefused.reduce((n, r) => n + r.sites, 0);
        expect(refused).toBe(4);
      });
    },
    ownTimeout(60_000),
  );

  test(
    "a clock call in a page-field property is dropped as declarative, not mutated",
    async () => {
      await withProject(async (dir) => {
        await Bun.write(
          join(dir, "Al/P.Page.al"),
          `page 79331 "P" { layout { area(Content) { field(X; Rec.X) { Visible = Today() > 0D; } } } }`,
        );
        const set = await generateMutationSet(dir, { operators: [NAME] });
        expect(swaps(set).length).toBe(3);
        expect(set.declarativeSites.reduce((n, d) => n + d.sites, 0)).toBeGreaterThan(0);
      });
    },
    ownTimeout(60_000),
  );

  test(
    "--operator naming it with another operator walks both",
    async () => {
      await withProject(async (dir) => {
        const set = await generateMutationSet(dir, { operators: [NAME, "lethal.empty-block"] });
        const names = new Set(set.files.flatMap((f) => f.specs.map((s) => s.operatorName)));
        expect(names.has(NAME)).toBe(true);
        expect(names.has("lethal.empty-block")).toBe(true);
      });
    },
    ownTimeout(60_000),
  );
});
