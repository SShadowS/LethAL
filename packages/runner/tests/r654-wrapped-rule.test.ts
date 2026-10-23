// R654 S1, r1 I1 (plan docs/superpowers/plans/2026-10-22-r654-retire-dotnet-alrunner.md): the
// #if-wrapped-file rule is keyed on its own parameter (`WrappedRule`), never on the backend kind,
// so retiring the .NET al-runner (v2) cannot silently change what a v3 session refuses.
// (a) pins today's exact map: a v3 session refuses an R-300b ADMITTED wrapped file's objects; an
// object inside the wrapper gets `refusedCoverageReason`, and only a bare object before the
// wrapper gets `refusedWholeFileReason` (r2 D-m1). (b) the coverage index's rule admits that file.
// (c) `carryBarredFiles` (extracted from `runSession`, r2 D-m2) follows the same rule.
import { beforeAll, describe, expect, test } from "bun:test";
import { initParser, parseAL, wrapRoot } from "@lethal/engine";
import {
  coverageRefusedObjects,
  refusedCoverageReason,
  refusedWholeFileReason,
  wrappedRuleFor,
} from "../src/line-map";
import { carryBarredFiles } from "../src/orchestrator";

beforeAll(async () => {
  await initParser();
});

/** R-300b's measured W1 shape (`r300b-wrapped.test.ts`): one wrapped codeunit alone in its file. */
const W1 = `#if PROBESYM
namespace LethAL.R300bProbe;

codeunit 91900 "R300b W1 Wrapped"
{
    procedure Hit(): Integer
    begin
        exit(9001);
    end;
}
#endif
`;
const W1_FILE = "src/W1.Codeunit.al";
/** A bare codeunit BEFORE a wrapper: not admitted anywhere. */
const BARE_BEFORE = `codeunit 91921 "R654 Bare"
{
    procedure Two(): Integer
    begin
        exit(2);
    end;
}
${W1}`;
const BARE_FILE = "src/Bare.Codeunit.al";

const files = (src: Record<string, string>) =>
  Object.entries(src).map(([path, text]) => ({ path, root: wrapRoot(parseAL(text)) }));

describe("R654 I1 (a): the rule each backend kind gets, and what a v3 session refuses", () => {
  // R654 S3: the .NET al-runner kind is gone; the `al-runner-index` rule stays (I1) and is reached
  // by its own name below.
  test("the exact map: bcdev bc-shape, al-runner-v3 refuse-wrapped", () => {
    expect([wrappedRuleFor("bcdev"), wrappedRuleFor("al-runner-v3")]).toEqual([
      "bc-shape",
      "refuse-wrapped",
    ]);
  });

  test("a v3 session refuses every object of an admitted wrapped file, by today's sentences", () => {
    const refused = coverageRefusedObjects(
      files({ [W1_FILE]: W1, [BARE_FILE]: BARE_BEFORE }),
      wrappedRuleFor("al-runner-v3"),
    );
    expect(Object.fromEntries(refused)).toEqual({
      "codeunit:91900": refusedCoverageReason("Codeunit", 91900, BARE_FILE),
      "codeunit:91921": refusedWholeFileReason("Codeunit", 91921, BARE_FILE),
    });
    // W1 alone: the same key, its own file's sentence (the later file wins the key above).
    expect(
      Object.fromEntries(
        coverageRefusedObjects(files({ [W1_FILE]: W1 }), wrappedRuleFor("al-runner-v3")),
      ),
    ).toEqual({ "codeunit:91900": refusedCoverageReason("Codeunit", 91900, W1_FILE) });
  });
});

describe("R654 I1 (b): the al-runner index rule admits the measured shape", () => {
  test("under the al-runner-index rule, an admitted W1 refuses nothing", () => {
    expect(coverageRefusedObjects(files({ [W1_FILE]: W1 }), "al-runner-index").size).toBe(0);
  });
});

describe("R654 I1 (c): carryBarredFiles follows the rule", () => {
  test("a v3 session bars no file (it admits none); the index rule bars the admitted file", () => {
    const fs = files({ [W1_FILE]: W1, [BARE_FILE]: BARE_BEFORE });
    expect([...carryBarredFiles(fs, wrappedRuleFor("al-runner-v3"), new Map())]).toEqual([]);
    expect([...carryBarredFiles(fs, "al-runner-index", new Map())]).toEqual([W1_FILE]);
  });

  test("bcdev with no arms for a file bars nothing (admittedOnBc needs the arms)", () => {
    const fs = files({ [W1_FILE]: W1 });
    expect([...carryBarredFiles(fs, wrappedRuleFor("bcdev"), new Map())]).toEqual([]);
  });
});
