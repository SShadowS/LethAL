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
 * R868, PR-209. `lethal.condition-true` (#36) and `lethal.blank-argument` (#34) are Tier 1 and, since
 * PR-209, DEFAULT operators (R868 made them opt-in; the old default set is now `--profile slim`).
 *   - DEFAULT: a default run holds both operators' sites, with R868's hang rules applied.
 *   - SLIM: `profile: "slim"` does not walk them: its specs and hang counts are the default run's
 *     without the two, and its `numberingDigest` differs from the default's.
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

describe("R868, PR-209: the two Tier 1 operators that are default operators", () => {
  test("operatorTiers knows both as Tier 1", () => {
    expect(operatorTiers.get(COND)).toBe(1);
    expect(operatorTiers.get(BLANK)).toBe(1);
  });

  test("admittedOperatorNames: exclusion admits them now; swap-workdate-today stays opt-in", () => {
    const registered = [...operatorTiers.keys()];
    const excluded = admittedOperatorNames(
      { excludeOperators: ["lethal.empty-block"] },
      registered,
    );
    expect(excluded?.has(COND)).toBe(true);
    expect(excluded?.has(BLANK)).toBe(true);
    expect(excluded?.has("lethal.swap-workdate-today")).toBe(false);
    expect([
      ...(admittedOperatorNames({ operators: ["condition-true"] }, registered) ?? []),
    ]).toEqual([COND]);
  });

  test(
    "DEFAULT: a default run holds both operators' sites; slim does not walk them",
    async () => {
      await withProject(async (dir) => {
        const plain = await generateMutationSet(dir);
        const slim = await generateMutationSet(dir, {
          excludeOperators: [COND, BLANK],
          profile: "slim",
        });
        // The default run holds the sites the ON tests below name.
        expect(specs(plain, COND).map((s) => s.split("|")[2])).toEqual(["A->true", "B->true"]);
        expect(specs(plain, BLANK).length).toBe(3);
        // Slim is the default run without the two: the old default set.
        expect(specs(slim, COND)).toEqual([]);
        expect(specs(slim, BLANK)).toEqual([]);
        expect(specs(slim)).toEqual(
          specs(plain).filter((s) => !s.startsWith(`${COND}|`) && !s.startsWith(`${BLANK}|`)),
        );
        // The loop shape R868 refuses is counted in the default run and never reached by slim.
        const total = (s: SetResult) => s.hangRefused.reduce((n, f) => n + f.sites, 0);
        expect(total(plain)).toBe(total(slim) + 1);
        expect(digest(plain)).not.toBe(digest(slim));
        // Naming a default operator only runs just that one.
        const flip = await generateMutationSet(dir, { operators: [FLIP] });
        expect(specs(flip)).toEqual(ofName(plain, FLIP));
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

  test(
    "BOTH on with delete-logical: `A and true` and `true or A` abort nothing (dedupeSpecs), alone and with every default operator that has a site",
    async () => {
      await withProject(async (dir) => {
        await Bun.write(
          join(dir, "Al/Logic.Codeunit.al"),
          `codeunit 79631 "Logic"
{
    procedure P(A: Boolean; B: Boolean)
    var
        N: Integer;
    begin
        if A and true then
            N := 1;
        if true or A then
            N := 2;
        if A and B then
            N := 3;
    end;
}
`,
        );
        const DL = ["lethal.delete-logical-left", "lethal.delete-logical-right"];
        const alone = await generateMutationSet(dir, { operators: [...DL, COND, BLANK] });
        // The two bare-true conditions are left to delete-logical; `A and B` is condition-true's.
        const condTexts = specs(alone, COND).map((s) => s.split("|")[2]);
        expect(condTexts).not.toContain("A and true->true");
        expect(condTexts).not.toContain("true or A->true");
        expect(condTexts).toContain("A and B->true");
        // Every default operator with a site in this project, plus both opt-ins.
        const defaults = await generateMutationSet(dir);
        const names = [...new Set(specs(defaults).map((s) => s.split("|")[0] as string))];
        const all = await generateMutationSet(dir, { operators: [...names, COND, BLANK] });
        expect(specs(all, COND).length).toBe(specs(alone, COND).length);
        // The default run already holds both operators, so naming everything changes nothing.
        expect(specs(all)).toEqual(specs(defaults));
      });
    },
    ownTimeout(60_000),
  );
});
