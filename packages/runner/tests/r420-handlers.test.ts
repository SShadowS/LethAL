import { beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import type { TestMethodRef } from "../src/backend";
import { discoverTests, regexTestsWithOffsets, testsInAlSource } from "../src/discovery";
import { testDigestKey, testDigestsOfModel, testDigestsOfSources } from "../src/test-digest";
import {
  type Proc,
  analyzeTestPageSources,
  buildTestAppModel,
  readTestAppSources,
} from "../src/testpage-scan";

/**
 * R420 part 2 (plan §3): a `[HandlerFunctions]` inside a `#if` in a test's attribute run. Part 1
 * discovers these tests; this file pins that the TestPage scan's model and the per-test digest
 * read every arm's attributes (the union), and that the digest span starts at the first node of
 * the attribute run, the `#if` included. The shapes are r420-test-shapes.test.ts's, compiled by
 * alc there.
 */

const S1 = `codeunit 92451 "S1"
{
    Subtype = Test;

    [Test]
#if X
    [HandlerFunctions('MsgH')]
#endif
    procedure T1()
    begin
    end;

    [MessageHandler]
    procedure MsgH(Msg: Text[1024])
    begin
    end;
}
`;

const S3 = `codeunit 92453 "S3"
{
    Subtype = Test;

    [Test]
#if X
    [HandlerFunctions('MsgH')]
#else
    [HandlerFunctions('ConfirmYes')]
#endif
    procedure T3()
    begin
    end;

    [MessageHandler]
    procedure MsgH(Msg: Text[1024])
    begin
    end;

    [ConfirmHandler]
    procedure ConfirmYes(Question: Text[1024]; var Reply: Boolean)
    begin
        Reply := true;
    end;
}
`;

const S9 = `codeunit 92459 "S9"
{
    Subtype = Test;

#if X
    [Test]
#else
    [Test]
    [HandlerFunctions('MsgH')]
#endif
    procedure T9()
    begin
    end;

    [MessageHandler]
    procedure MsgH(Msg: Text[1024])
    begin
    end;
}
`;

/** S11 with a handler list beside the `[Test]` OUTSIDE the `#if`: one whole procedure per arm. */
const S11H = `codeunit 92470 "S11"
{
    Subtype = Test;

    [Test]
    [HandlerFunctions('MsgH')]
#if X
    procedure A()
    begin
    end;
#else
    procedure B()
    begin
    end;
#endif

    [MessageHandler]
    procedure MsgH(Msg: Text[1024])
    begin
    end;
}
`;

/** The orchestrator's shape: an attribute `#if` BEFORE `[Test]`. The regex has always found it. */
const PRE = `codeunit 92471 "Pre"
{
    Subtype = Test;

#if X
    [HandlerFunctions('MsgH')]
#endif
    [Test]
    procedure O()
    begin
    end;

    [MessageHandler]
    procedure MsgH(Msg: Text[1024])
    begin
    end;
}
`;

/**
 * PRE's digest under the rule before R420 part 2 (span from `[Test]`, no handler from the `#if`),
 * computed by that code (099e6231) with `INPUTS` below. A stored digest of this value is what an
 * upgrade compares against, so it must differ once, here.
 */
// R-385 moved the scheme tag from v2 to v3; the hash after the tag is unchanged.
const PRE_DIGEST_BEFORE_R420 =
  "v3:3a1b8110f582d76cc0ebd1bb6ac3febc40780e19a168bdd6cca5088a6761afa8";

const INPUTS = { dependencies: "deps", buildInputs: "build" };
const EMPTY_MSGH = "procedure MsgH(Msg: Text[1024])\n    begin\n    end;";
const EDITED_MSGH = "procedure MsgH(Msg: Text[1024])\n    begin\n        Message(Msg);\n    end;";

beforeAll(async () => {
  await initParser();
});

const ref = (codeunitId: number, codeunitName: string, method: string): TestMethodRef => ({
  codeunitId,
  codeunitName,
  method,
  file: `${codeunitName}.Codeunit.al`,
});

function digestOf(text: string, t: TestMethodRef): string {
  const key = testDigestKey(t);
  const d = testDigestsOfSources([{ path: t.file ?? "", text }], [t], INPUTS)[key];
  if (d === undefined) throw new Error(`no digest for ${key}`);
  return d;
}

/** The test's own span hash and its codeunit's parts hash (everything outside procedure spans). */
function spanAndParts(text: string, t: TestMethodRef): { span: string; parts: string } {
  const model = buildTestAppModel([{ path: t.file ?? "", text }]);
  const { parts } = testDigestsOfModel(model, [t], INPUTS);
  const span = parts.procs[`${t.codeunitId}:${t.codeunitName}.${t.method}`];
  const object = parts.objects[`codeunit:${t.codeunitId}:${t.codeunitName}`];
  if (span === undefined || object === undefined) throw new Error(`no parts for ${t.method}`);
  return { span, parts: object };
}

function procOf(text: string, name: string): Proc[] {
  const model = buildTestAppModel([{ path: "x.al", text }]);
  return model.units.flatMap((u) => u.procs.filter((p) => p.name === name.toLowerCase()));
}

function replaceOnce(text: string, from: string, to: string): string {
  if (!text.includes(from)) throw new Error(`fixture text not found: ${from}`);
  return text.replace(from, to);
}

describe("R420 part 2: every arm's [HandlerFunctions] in the attribute run", () => {
  test("S1, S3, S9: the scan's handler list holds every arm's handlers", () => {
    expect(procOf(S1, "T1").map((p) => p.handlers)).toEqual([["msgh"]]);
    expect(procOf(S3, "T3").map((p) => [...p.handlers].sort())).toEqual([["confirmyes", "msgh"]]);
    expect(procOf(S9, "T9").map((p) => p.handlers)).toEqual([["msgh"]]);
  });

  test("S1, S3, S9: editing a handler named only inside #if changes the test's digest", () => {
    const cases: Array<[string, TestMethodRef, string, string]> = [
      [S1, ref(92451, "S1", "T1"), EMPTY_MSGH, EDITED_MSGH],
      [S3, ref(92453, "S3", "T3"), EMPTY_MSGH, EDITED_MSGH],
      [S3, ref(92453, "S3", "T3"), "Reply := true;", "Reply := false;"],
      [S9, ref(92459, "S9", "T9"), EMPTY_MSGH, EDITED_MSGH],
    ];
    for (const [text, t, from, to] of cases) {
      expect(digestOf(replaceOnce(text, from, to), t)).not.toBe(digestOf(text, t));
    }
  });

  test("S9: the span starts at the #if, so the #if is the test's, not the codeunit's", () => {
    const t = ref(92459, "S9", "T9");
    const before = spanAndParts(S9, t);
    const after = spanAndParts(replaceOnce(S9, "#if X", "#if Y"), t);
    expect(after.span).not.toBe(before.span);
    expect(after.parts).toBe(before.parts);
  });

  test("the scan neither refuses nor errors on S1, S3, S9", () => {
    const files = [
      { path: "S1.Codeunit.al", text: S1 },
      { path: "S3.Codeunit.al", text: S3 },
      { path: "S9.Codeunit.al", text: S9 },
    ];
    const a = analyzeTestPageSources(files, [
      ref(92451, "S1", "T1"),
      ref(92453, "S3", "T3"),
      ref(92459, "S9", "T9"),
    ]);
    expect(a.errors).toEqual([]);
    expect([...a.refused]).toEqual([]);
  });
});

describe("R420 part 2: S11, a [Test] outside the #if and one whole procedure per arm", () => {
  test("each arm's procedure takes the attribute run before the #if", () => {
    expect(procOf(S11H, "A").map((p) => p.handlers)).toEqual([["msgh"]]);
    expect(procOf(S11H, "B").map((p) => p.handlers)).toEqual([["msgh"]]);
  });

  test("discovered, scanned without refusal, and digested", () => {
    const tests = testsInAlSource("S11.Codeunit.al", S11H);
    expect(tests.map((t) => t.method).sort()).toEqual(["A", "B"]);
    const a = analyzeTestPageSources([{ path: "S11.Codeunit.al", text: S11H }], tests);
    expect(a.errors).toEqual([]);
    expect([...a.refused]).toEqual([]);
    for (const t of tests) expect(digestOf(S11H, t)).toMatch(/^v3:[0-9a-f]{64}$/);
  });

  test("editing the handler changes both arms' digests; editing one arm leaves the other's", () => {
    const a = ref(92470, "S11", "A");
    const b = ref(92470, "S11", "B");
    const edited = replaceOnce(S11H, EMPTY_MSGH, EDITED_MSGH);
    expect(digestOf(edited, a)).not.toBe(digestOf(S11H, a));
    expect(digestOf(edited, b)).not.toBe(digestOf(S11H, b));
    const aEdited = replaceOnce(
      S11H,
      "procedure A()\n    begin\n",
      "procedure A()\n    begin\n        Message('a');\n",
    );
    expect(digestOf(aEdited, a)).not.toBe(digestOf(S11H, a));
    expect(digestOf(aEdited, b)).toBe(digestOf(S11H, b));
  });
});

describe("R420 part 2: an attribute #if BEFORE [Test], a shape discovered before R420", () => {
  test("found by the regex, on the regex path, both before and after", () => {
    expect(regexTestsWithOffsets("Pre.Codeunit.al", PRE).map((t) => t.ref.method)).toEqual(["O"]);
    expect(testsInAlSource("Pre.Codeunit.al", PRE).map((t) => t.method)).toEqual(["O"]);
  });

  test("its handler is read, and its digest changes once from the old rule's", () => {
    const t = ref(92471, "Pre", "O");
    expect(digestOf(PRE, t)).not.toBe(PRE_DIGEST_BEFORE_R420);
    expect(procOf(PRE, "O").map((p) => p.handlers)).toEqual([["msgh"]]);
    const before = spanAndParts(PRE, t);
    const after = spanAndParts(replaceOnce(PRE, "#if X", "#if Y"), t);
    expect(after.span).not.toBe(before.span);
    expect(after.parts).toBe(before.parts);
    expect(digestOf(replaceOnce(PRE, EMPTY_MSGH, EDITED_MSGH), t)).not.toBe(digestOf(PRE, t));
  });
});

/** The common BC shape: a helper (not a test) obsoleted under `#if not CLEAN24`, beside an
 *  unchanged test. Review fix 2. */
const OBS = `codeunit 50200 "Obs"
{
    Subtype = Test;

    [Test]
    procedure T()
    begin
        Helper();
    end;

#if not CLEAN24
    [Obsolete('x', '24.0')]
#endif
    procedure Helper()
    begin
    end;
}
`;

/** OBS under 099e6231's code (before part 2), with `INPUTS`: T's digest, the codeunit's parts hash
 *  and Helper's span hash. Reproduced from that commit's tree, not from this file's code. */
const OBS_BEFORE_R420 = {
  // R-385: scheme tag v2 -> v3, the hash unchanged.
  digest: "v3:e0432f64ad4b2dc3fc0b0a934bc1023d3ebb58f27b2480fa29612eeed6917d61",
  parts: "516f3dd855cebc5a",
  helperSpan: "ff25a5070a8e3890",
};

/** An event subscriber (not a test) whose attribute sits in an `#if`. */
const SUB = `codeunit 50201 "Sub"
{
    Subtype = Test;

    [Test]
    procedure T()
    begin
    end;

#if not CLEAN24
    [EventSubscriber(ObjectType::Codeunit, Codeunit::"Sub", 'OnX', '', false, false)]
#endif
    local procedure OnX()
    begin
    end;
}
`;

describe("R420 review fix 2: a non-test procedure keeps its pre-R420 attribute run", () => {
  test("a helper under #if [Obsolete]: the test's digest and the parts hash are 099e6231's", () => {
    const t = ref(50200, "Obs", "T");
    const model = buildTestAppModel([{ path: t.file ?? "", text: OBS }]);
    const { digests, parts } = testDigestsOfModel(model, [t], INPUTS);
    expect(digests[testDigestKey(t)]).toBe(OBS_BEFORE_R420.digest);
    expect(parts.objects["codeunit:50200:Obs"]).toBe(OBS_BEFORE_R420.parts);
    expect(parts.procs["50200:Obs.Helper"]).toBe(OBS_BEFORE_R420.helperSpan);
  });

  test("an [EventSubscriber] inside #if on a non-test procedure is read as before", () => {
    expect(procOf(SUB, "OnX").map((p) => p.subscriber)).toEqual([false]);
  });
});

/** Two handler lists and a repeated handler, no `#if`: the pre-R420 reading (nearest list,
 *  duplicates kept). Review fix 4. */
const NEAR = `codeunit 50202 "Near"
{
    Subtype = Test;

    [Test]
    [HandlerFunctions('MsgH')]
    [HandlerFunctions('ConfirmYes,ConfirmYes')]
    procedure T()
    begin
    end;
}
`;

describe("R420 review fix 4: the handler union only where the run took an #if", () => {
  test("no #if in the run: the nearest [HandlerFunctions] only, duplicates kept", () => {
    expect(procOf(NEAR, "T").map((p) => p.handlers)).toEqual([["confirmyes", "confirmyes"]]);
  });

  test("an #if in the run: the union, deduplicated", () => {
    const withIf = replaceOnce(
      NEAR,
      "    [HandlerFunctions('MsgH')]\n",
      "#if X\n    [HandlerFunctions('MsgH')]\n#endif\n",
    );
    expect(procOf(withIf, "T").map((p) => p.handlers)).toEqual([["confirmyes", "msgh"]]);
  });
});

describe("R420 part 2: no committed fixture's digest moves", () => {
  const REPO = join(import.meta.dir, "..", "..", "..");
  const PROJECTS = [
    "examples/credit-limit-tests",
    "examples/gift-card-tests",
    "fixtures/sandbox-data-tests",
    "fixtures/sandbox-hang-tests",
    "fixtures/sandbox-harden-tests",
    "fixtures/sandbox-layout-tests",
    "fixtures/sandbox-multiobject-tests",
    "fixtures/sandbox-symbols-tests",
    "fixtures/sandbox-tests",
  ];
  // Recorded under 099e6231, before this change. Every digest, and every procedure's span hash
  // and object's parts hash (those of procedures no test reaches included). A deliberate fixture
  // edit re-records with `bun test --update-snapshots packages/runner/tests/r420-handlers.test.ts`.
  for (const project of PROJECTS) {
    test(project, async () => {
      const dir = join(REPO, project);
      const tests = await discoverTests(dir);
      const model = buildTestAppModel(await readTestAppSources(dir));
      const { digests, parts } = testDigestsOfModel(model, tests, INPUTS);
      expect(Object.keys(digests).length).toBeGreaterThan(0);
      expect({ digests, procs: parts.procs, objects: parts.objects }).toMatchSnapshot();
    });
  }
});
