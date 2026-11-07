import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownTimeout } from "@lethal/engine/own-timeout";
import { numberIdentityOrdinals, runIdentityEntries } from "@lethal/schemata";
import { admittedOperatorNames, generateMutationSet, operatorTiers } from "../src/orchestrator";
import { numberingDigestOf } from "../src/selection";
import { removeRunScratchAfterAll } from "./helpers/scratch";

removeRunScratchAfterAll();

/**
 * R868. `lethal.condition-true` (#36) and `lethal.blank-argument` (#34) are OPT-IN, Tier 1.
 *   - LEAK: a default run walks neither. Its specs, its hang counts and its `numberingDigest` equal
 *     those of a run that names only the default operators. A leak is a changed default run.
 *   - ON alone, each adds specs of its own name and removes nothing.
 *   - BOTH on, with `flip-boolean-literal`: no dedupe clash. The prototype threw in `dedupeSpecs`
 *     because `blank-argument` was asked about every node, a boolean literal included.
 */
const COND = "lethal.condition-true";
const BLANK = "lethal.blank-argument";
const FLIP = "lethal.flip-boolean-literal";

const APP_JSON = JSON.stringify({
  id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeef",
  name: "T",
  publisher: "P",
  version: "1.0.0.0",
  idRanges: [{ from: 79600, to: 79699 }],
});

const AL = `codeunit 79630 "Optin"
{
    procedure Run(A: Boolean; T: Text)
    var
        N: Integer;
    begin
        if A then
            N := 1;
        if true then
            N := 2;
        Use(T, true);
        Use(T, A);
    end;

    local procedure Use(X: Text; B: Boolean)
    begin
        if B then
            Message(X);
    end;

    procedure Looping(Step: Integer; N: Integer)
    var
        I: Integer;
    begin
        if Step > 0 then
            while I < N do
                I += Step;
    end;
}
`;

async function withProject(body: (dir: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "lethal-r868-"));
  const dir = join(root, "app");
  await Bun.write(join(dir, "app.json"), APP_JSON);
  await Bun.write(join(dir, "Al/Optin.Codeunit.al"), AL);
  try {
    await body(dir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

type SetResult = Awaited<ReturnType<typeof generateMutationSet>>;
const specs = (set: SetResult, only?: string): string[] =>
  set.files
    .flatMap((f) => f.specs)
    .filter((s) => only === undefined || s.operatorName === only)
    .map((s) => `${s.operatorName}|${s.before.startIndex}|${s.before.text}->${s.after.text}`)
    .sort();
const digest = (set: SetResult): string => {
  const entries = runIdentityEntries(set.files, operatorTiers, set.reservedIdentityEntries);
  return numberingDigestOf(entries, numberIdentityOrdinals(entries));
};
/** The specs of `set` that are not `drop`'s, compared with the default run's specs of `keep`. */
const without = (set: SetResult, drop: string): string[] =>
  specs(set).filter((s) => !s.startsWith(`${drop}|`));
const ofName = (set: SetResult, keep: string): string[] => specs(set, keep);

describe("R868: the two opt-in Tier 1 operators", () => {
  test("operatorTiers knows both as Tier 1", () => {
    expect(operatorTiers.get(COND)).toBe(1);
    expect(operatorTiers.get(BLANK)).toBe(1);
  });

  test("admittedOperatorNames: exclusion never admits them, naming one does", () => {
    const registered = [...operatorTiers.keys()];
    const excluded = admittedOperatorNames(
      { excludeOperators: ["lethal.empty-block"] },
      registered,
    );
    expect(excluded?.has(COND)).toBe(false);
    expect(excluded?.has(BLANK)).toBe(false);
    expect([
      ...(admittedOperatorNames({ operators: ["condition-true"] }, registered) ?? []),
    ]).toEqual([COND]);
  });

  test(
    "LEAK: a default run walks neither operator: specs, hang counts and numberingDigest equal a run that excludes them",
    async () => {
      await withProject(async (dir) => {
        const plain = await generateMutationSet(dir);
        const excluded = await generateMutationSet(dir, { excludeOperators: [COND, BLANK] });
        // The project holds sites for both operators (the ON tests below), and the default run
        // holds none of them.
        expect(specs(plain).length).toBeGreaterThan(0);
        expect(specs(plain, COND)).toEqual([]);
        expect(specs(plain, BLANK)).toEqual([]);
        expect(specs(plain)).toEqual(specs(excluded));
        expect(plain.hangRefused).toEqual(excluded.hangRefused);
        expect(digest(plain)).toBe(digest(excluded));
        // Naming a default operator only still leaves the opt-in ones out.
        const flip = await generateMutationSet(dir, { operators: [FLIP] });
        expect(specs(flip)).toEqual(ofName(plain, FLIP));
        expect(flip.hangRefused.some((f) => JSON.stringify(f).includes("condition-true"))).toBe(
          false,
        );
      });
    },
    ownTimeout(60_000),
  );

  test(
    "ON alone: condition-true adds its specs and removes none; the loop shape is hang-refused",
    async () => {
      await withProject(async (dir) => {
        const plain = await generateMutationSet(dir);
        const flipOnly = await generateMutationSet(dir, { operators: [FLIP] });
        const on = await generateMutationSet(dir, { operators: [FLIP, COND] });
        expect(without(on, COND)).toEqual(specs(flipOnly));
        // `if A`, `if B`: claimed. `if true` is a literal; `if Step > 0 then while ...` is refused.
        expect(specs(on, COND).map((s) => s.split("|")[2])).toEqual(["A->true", "B->true"]);
        expect(on.hangRefused.reduce((n, f) => n + f.sites, 0)).toBe(
          flipOnly.hangRefused.reduce((n, f) => n + f.sites, 0) + 1,
        );
        expect(digest(on)).not.toBe(digest(plain));
      });
    },
    ownTimeout(60_000),
  );

  test(
    "ON alone: blank-argument adds its specs and removes none",
    async () => {
      await withProject(async (dir) => {
        const flipOnly = await generateMutationSet(dir, { operators: [FLIP] });
        const on = await generateMutationSet(dir, { operators: [FLIP, BLANK] });
        expect(without(on, BLANK)).toEqual(specs(flipOnly));
        // `Use(T, true)`: T blanked, the literal is flip-boolean-literal's. `Use(T, A)`: both.
        expect(
          specs(on, BLANK)
            .map((s) => s.split("|")[2])
            .sort(),
        ).toEqual(["A->false", "T->''", "T->''"]);
      });
    },
    ownTimeout(60_000),
  );

  test(
    "BOTH on with flip-boolean-literal: no dedupe clash, the literal stays flip's",
    async () => {
      await withProject(async (dir) => {
        const on = await generateMutationSet(dir, { operators: [FLIP, COND, BLANK] });
        const names = specs(on).map((s) => s.split("|")[0]);
        expect(names.filter((n) => n === COND).length).toBe(2);
        expect(names.filter((n) => n === BLANK).length).toBe(3);
        // `true` in `if true` and in `Use(T, true)`: flip-boolean-literal, once each.
        expect(specs(on, FLIP).map((s) => s.split("|")[2])).toEqual(["true->false", "true->false"]);
        // Together, the walk adds exactly the sum of each alone.
        const condOnly = await generateMutationSet(dir, { operators: [FLIP, COND] });
        const blankOnly = await generateMutationSet(dir, { operators: [FLIP, BLANK] });
        expect(specs(on).length).toBe(
          specs(condOnly).length +
            specs(blankOnly).length -
            specs(await generateMutationSet(dir, { operators: [FLIP] })).length,
        );
      });
    },
    ownTimeout(60_000),
  );
});
