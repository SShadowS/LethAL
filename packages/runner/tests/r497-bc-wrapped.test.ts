import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateArms, initParser, parseAL, wrapRoot } from "@lethal/engine";
import { writeInstrumentedProject } from "@lethal/schemata";
import {
  bcWrappedShapeRefusal,
  buildLineMap,
  coverageRefusedFromSources,
  lineMapFromSources,
  refusedObjectsOfFile,
} from "../src/line-map";
import { generateMutationSet, identityOrdinalsOf, operatorTiers } from "../src/orchestrator";

/**
 * R497: the BC paths score the `#if`-wrapped shapes R-300b measured on Cronus28 (fenced under H1a,
 * the hub by procedure name) once the build's symbols are known, and keep every other shape
 * refused by name. Without symbols, everything is as before (refused).
 */
beforeAll(async () => {
  await initParser();
});

const PROBE = join(import.meta.dir, "..", "..", "..", "scripts", "r300b-probe", "target", "src");
const probeSources = readdirSync(PROBE).map((f) => ({
  path: f,
  text: readFileSync(join(PROBE, f), "utf8"),
}));
const PROBE_DECLARED = new Set(
  [91900, 91901, 91902, 91903, 91904, 91905].map((id) => `codeunit:${id}`),
);

const BODY = (name: string): string =>
  `{\n    procedure ${name}()\n    begin\n        Message('x');\n    end;\n}\n`;
const cu = (id: number, name: string) => `codeunit ${id} "C${id}"\n${BODY(name)}`;

function shapeOf(text: string, symbols: readonly string[] = []): string | undefined {
  const root = wrapRoot(parseAL(text));
  return bcWrappedShapeRefusal(root, evaluateArms(root, text, symbols));
}

describe("R497: the BC shape predicate admits exactly the measured shapes", () => {
  test("admitted: one arm (W1), two arms either arm compiled (E1, Q), one bare object before / after", () => {
    expect(shapeOf(`#if not X\n${cu(50100, "A")}#endif\n`)).toBeUndefined();
    expect(shapeOf(`#if X\n${cu(50100, "A")}#else\n${cu(50100, "B")}#endif\n`)).toBeUndefined();
    expect(shapeOf(`#if not X\n${cu(50100, "A")}#else\n${cu(50100, "B")}#endif\n`)).toBeUndefined();
    expect(
      shapeOf(`${cu(50101, "P")}#if not X\n${cu(50100, "A")}#endif\n${cu(50102, "R")}`),
    ).toBeUndefined();
  });

  test("refused by name: each unmeasured shape", () => {
    const two = `#if not X\n${cu(50100, "A")}#endif\n#if not Y\n${cu(50101, "B")}#endif\n`;
    expect(shapeOf(two)).toBe("more than one #if object wrapper");
    expect(shapeOf(`#if X\n${cu(50100, "A")}#elif Y\n${cu(50100, "B")}#endif\n`)).toBe(
      "an #elif arm",
    );
    expect(shapeOf(`#if not X\n#if not Y\n${cu(50100, "A")}#endif\n#endif\n`)).toBe(
      "a nested #if object wrapper",
    );
    expect(shapeOf(`#if not X\n${cu(50100, "A")}${cu(50101, "B")}#endif\n`)).toBe(
      "an arm with more than one object",
    );
    expect(shapeOf(`#if X\n${cu(50100, "A")}#else\n${cu(50101, "B")}#endif\n`)).toBe(
      "arms declaring different objects",
    );
    expect(shapeOf(`#if X\n${cu(50100, "A")}#endif\n`)).toBe(
      "a wrapper whose object is compiled out",
    );
    expect(shapeOf(`${cu(50101, "P")}${cu(50103, "P2")}#if not X\n${cu(50100, "A")}#endif\n`)).toBe(
      "more than one object before the wrapper",
    );
    expect(shapeOf(`#if not X\n${cu(50100, "A")}#endif\n${cu(50101, "R")}${cu(50103, "R2")}`)).toBe(
      "more than one object after the wrapper",
    );
    expect(shapeOf(`#if not X\nenum 50100 E { value(0; A) { } }\n#endif\n`)).toBe(
      "an object with no coverage identity",
    );
  });
});

describe("R497: H1a, against the line numbers BC reported for the R-300b probe", () => {
  // Measured on Cronus28, two rounds (`/coord/handoff/R-300b/bc-results.md`), BC Code Coverage's
  // object-relative `Line No.` of the three marker statements in each object's reached procedure.
  const MEASURED: [number, string, number[]][] = [
    [91900, "Hit", [10, 14, 18]], // W1, one arm
    [91901, "Hit", [10, 14, 18]], // C1, control
    [91902, "AElseHit", [18, 22, 27]], // E1, two arms, #else compiled
    [91903, "Hit", [7, 11, 15]], // P, control, bare first object
    [91904, "QIfHit", [8, 12, 16]], // Q, wrapped in the middle
    [91905, "Hit", [18, 22, 26]], // R, bare object after the wrapper: H1b said 7, 11, 15
  ];

  test("with the build's symbols every measured line names the reached procedure", async () => {
    const map = await lineMapFromSources(probeSources, PROBE_DECLARED, undefined, ["PROBESYM"]);
    for (const [id, proc, lines] of MEASURED)
      for (const line of lines)
        expect([id, line, map.lookup("Codeunit", id, line)]).toEqual([id, line, proc]);
    // Revert H1a to H1b and R's lines move 11 down: the line H1b predicted is not in R's procedure.
    expect(map.lookup("Codeunit", 91905, 7)).toBeUndefined();
  });

  test("without symbols every wrapped object, and R after the wrapper, stays refused (as before)", async () => {
    const map = await lineMapFromSources(probeSources, PROBE_DECLARED);
    for (const id of [91900, 91902, 91904, 91905]) expect(map.isRefused("Codeunit", id)).toBe(true);
    expect(map.lookup("Codeunit", 91901, 10)).toBe("Hit");
  });
});

describe("R497 A5: H1a through the real path, on the INSTRUMENTED text alc compiles", () => {
  // The probe project instrumented as a run instruments it, then `buildLineMap` over the batch dir
  // with the build's symbols (what `indexArtifact` does after `useBuildSymbols`). Each first marker
  // line is turned into BC's object-relative line by H1a, read off the instrumented text itself:
  // base = one past the last `}` (a compiled object's end) above the marker's object header.
  test("Q (middle, #if compiled), R (after the wrapper) and E1 (#else compiled) name the reached procedure", async () => {
    const project = await mkdtemp(join(tmpdir(), "lethal-r497-probe-"));
    const out = await mkdtemp(join(tmpdir(), "lethal-r497-out-"));
    try {
      await cp(join(PROBE, ".."), project, { recursive: true });
      const set = await generateMutationSet(project, { emit: () => {} });
      await writeInstrumentedProject({
        targetDir: out,
        files: set.files,
        identityOrdinals: identityOrdinalsOf(set),
        selectorIds: { selectorId: 91927, controlId: 91928, tableId: 91929 },
        artifactId: "0123456789abcdef0123456789abcdef",
        targetAppId: "2f6483db-5b5f-4b17-b2aa-852530a8a00b",
        operatorTiers,
      });
      const map = await buildLineMap(out, PROBE_DECLARED, ["PROBESYM"]);
      const lines = (f: string) => readFileSync(join(out, f), "utf8").split("\n");
      /**
       * `marker`'s object-relative line when the object's base is one past the last `}` above the
       * first line containing `anchor` (H1a: the previous COMPILED object's end; `anchor` undefined:
       * no previous object, base 1).
       */
      const objectLine = (f: string, marker: string, anchor?: string) => {
        const ls = lines(f);
        const at = ls.findIndex((l) => l.includes(marker)) + 1;
        if (anchor === undefined) return at;
        const from = ls.findIndex((l) => l.trim() === anchor);
        for (let i = from - 1; i >= 0; i--) if (ls[i]?.trimEnd() === "}") return at - (i + 1);
        throw new Error(`no } above ${anchor}`);
      };
      const M1 = "M1MultiObject.Codeunit.al";
      const q = objectLine(M1, "X := 9301;", "#if PROBESYM"); // P's end
      const r = objectLine(M1, "X := 9401;", "#else"); // Q's COMPILED arm's end
      // H1b: base one past the `#endif` line itself.
      const m1 = lines(M1);
      const rH1b =
        m1.findIndex((l) => l.includes("X := 9401;")) - m1.findIndex((l) => l.trim() === "#endif");
      const e1 = objectLine("E1TwoArm.Codeunit.al", "X := 9151;"); // first object: base 1
      expect(map.lookup("Codeunit", 91904, q)).toBe("QIfHit");
      expect(map.lookup("Codeunit", 91905, r)).toBe("Hit");
      expect(map.lookup("Codeunit", 91902, e1)).toBe("AElseHit");
      // H1b would base R one past `#endif`, 11 lines lower here too. Instrumentation lengthens
      // `Hit`, so that line can still fall inside it: the H1a-vs-H1b discriminator is the raw-probe
      // test above (BC's own numbers); this one pins the path (symbols, arm filter, H1a's base).
      expect(r - rH1b).toBe(11);
    } finally {
      await rm(project, { recursive: true, force: true });
      await rm(out, { recursive: true, force: true });
    }
  });
});

describe("R497 A1: a compiled-out declaration never refuses its compiled twin in another file", () => {
  const A = { path: "A.Codeunit.al", text: `#if X\n${cu(50100, "InA")}#endif\n` };
  const B = { path: "B.Codeunit.al", text: `#if not X\n${cu(50100, "InB")}#endif\n` };
  const declared = new Set(["codeunit:50100"]);

  test("under X, A is compiled and scored; B gives no entry and no refusal", async () => {
    for (const order of [
      [A, B],
      [B, A],
    ]) {
      const map = await lineMapFromSources(order, declared, undefined, ["X"]);
      expect(map.isRefused("Codeunit", 50100)).toBe(false);
      expect(map.lookup("Codeunit", 50100, 6)).toBe("InA");
      expect(await coverageRefusedFromSources(order, ["X"])).toEqual(new Map());
    }
  });

  test("a compiled-out wrapper's bare neighbour stays refused, the compiled-out key does not", () => {
    const text = `${cu(50101, "P")}#if X\n${cu(50100, "InB")}#endif\n`;
    const root = wrapRoot(parseAL(text));
    const refused = refusedObjectsOfFile(root, "N.al", "bcdev", evaluateArms(root, text, []));
    expect([...refused.keys()]).toEqual(["codeunit:50101"]);
    expect(refused.get("codeunit:50101")).toContain("a wrapper whose object is compiled out");
  });
});

describe("R497 A3: two compiled entries for one declared key refuse it by name", () => {
  test("two plain files declaring one codeunit: refused, never last-wins", async () => {
    const map = await lineMapFromSources(
      [
        { path: "One.al", text: cu(50100, "First") },
        { path: "Two.al", text: cu(50100, "Second") },
      ],
      new Set(["codeunit:50100"]),
    );
    expect(map.isRefused("Codeunit", 50100)).toBe(true);
    expect(map.refusalReason("Codeunit", 50100)).toContain("more than one declaration");
  });
});

describe("R497: refusedObjectsOfFile on bcdev with arms", () => {
  test("an admitted file refuses nothing; a refused shape names its shape; no arms: as before", () => {
    const ok = `#if not X\n${cu(50100, "A")}#endif\n`;
    const okRoot = wrapRoot(parseAL(ok));
    expect(refusedObjectsOfFile(okRoot, "W.al", "bcdev", evaluateArms(okRoot, ok, []))).toEqual(
      new Map(),
    );
    expect(refusedObjectsOfFile(okRoot, "W.al", "bcdev").has("codeunit:50100")).toBe(true);
    const bad = `#if not X\n#if not Y\n${cu(50100, "A")}#endif\n#endif\n`;
    const badRoot = wrapRoot(parseAL(bad));
    const r = refusedObjectsOfFile(badRoot, "N.al", "bcdev", evaluateArms(badRoot, bad, []));
    expect(r.get("codeunit:50100")).toContain("a nested #if object wrapper");
  });

  test("arms that cannot be decided: every object refused, named as undecided", () => {
    const text = `#define 1X\n#if not X\n${cu(50100, "A")}#endif\n`;
    const root = wrapRoot(parseAL(text));
    const arms = evaluateArms(root, text, []);
    expect(arms.kind).toBe("undecided");
    expect(refusedObjectsOfFile(root, "U.al", "bcdev", arms).get("codeunit:50100")).toContain(
      "could not be evaluated",
    );
  });
});
