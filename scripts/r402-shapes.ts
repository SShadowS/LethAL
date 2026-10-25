// R754: the generate-and-judge half of the R402 shape sweep, shared by scripts/r402-shape-sweep.ts
// (which also compiles the source and the instrumented artifact with alc) and r402-shapes.test.ts
// (the unit suite: no alc, no /coord, no server). One function per step, so the sweep and the test
// cannot drift apart.
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const R402_SHAPES_DIR = join(import.meta.dir, "fixtures", "r402");

/** The four builds every shape runs under, in expected.json's order. */
export const R402_BUILDS: readonly (readonly string[])[] = [
  [],
  ["LETHALX"],
  ["LETHALY"],
  ["LETHALX", "LETHALY"],
];

/** A shape's expected outcome: refused with a named reason prefix, or a spec count per build. */
export type R402Expected = { readonly refused?: string; readonly specs?: readonly number[] };

export function r402Expected(shapesDir: string = R402_SHAPES_DIR): Record<string, R402Expected> {
  const raw = JSON.parse(readFileSync(join(shapesDir, "expected.json"), "utf8")) as Record<
    string,
    unknown
  >;
  const out: Record<string, R402Expected> = {};
  for (const [k, v] of Object.entries(raw)) if (k !== "_comment") out[k] = v as R402Expected;
  return out;
}

/** The shape names (file stems), sorted. */
export function r402ShapeNames(shapesDir: string = R402_SHAPES_DIR): string[] {
  return readdirSync(shapesDir)
    .filter((n) => n.endsWith(".al"))
    .sort()
    .map((n) => n.replace(/\.al$/, ""));
}

/** What the sweep reads of each spec. */
export interface R402Spec {
  readonly operatorName: string;
  readonly hangCapable?: unknown;
  readonly before: { readonly text: string };
}

/** The slice of `generateMutationSet`'s result the sweep reads. */
export interface R402SetResult {
  readonly files: readonly { readonly specs: readonly R402Spec[] }[];
  readonly preprocExcluded: readonly { readonly reason: string; readonly detail?: string }[];
}

export type R402Generate = (
  projectDir: string,
  opts: { preprocessorSymbols: readonly string[]; emit: () => void },
) => Promise<R402SetResult>;

/**
 * Writes one shape as a project at `dir` (the given app.json, the shape as its only source file)
 * and, when `alpackagesFrom` is given, copies that symbol folder in (the sweep compiles; the unit
 * test does not, and generateMutationSet reads no symbols).
 */
export function writeShapeProject(
  dir: string,
  appJson: string,
  shapeText: string,
  alpackagesFrom?: string,
): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "app.json"), appJson);
  writeFileSync(join(dir, "src", "Shape.Codeunit.al"), shapeText);
  if (alpackagesFrom !== undefined)
    cpSync(alpackagesFrom, join(dir, ".alpackages"), { recursive: true });
}

/** One shape under one build: the result, its specs, and its preproc-undecided details. */
export async function runShape(
  generate: R402Generate,
  dir: string,
  build: readonly string[],
): Promise<{ res: R402SetResult; specs: R402Spec[]; undecided: string[] }> {
  const res = await generate(dir, { preprocessorSymbols: build, emit: () => {} });
  const specs = res.files.flatMap((x) => [...x.specs]);
  const undecided = res.preprocExcluded
    .filter((e) => e.reason === "preproc-undecided")
    .map((e) => e.detail ?? "");
  return { res, specs, undecided };
}

/**
 * The sweep's expectation check for one shape under build `buildIndex`: the problems, empty when it
 * matches. A refused shape must give exactly one preproc-undecided detail starting with the reason
 * and no spec; an admitted one no refusal and exactly its spec count.
 */
export function judgeShape(
  label: string,
  want: R402Expected,
  buildIndex: number,
  specCount: number,
  undecided: readonly string[],
): string[] {
  const problems: string[] = [];
  if (want.refused !== undefined) {
    if (undecided.length !== 1 || !(undecided[0] ?? "").startsWith(want.refused))
      problems.push(
        `${label}: expected refusal "${want.refused}", got ${JSON.stringify(undecided)}`,
      );
    if (specCount !== 0) problems.push(`${label}: refused shape emitted ${specCount} specs`);
  } else {
    if (undecided.length > 0)
      problems.push(`${label}: unexpected refusal ${JSON.stringify(undecided)}`);
    const n = want.specs?.[buildIndex];
    if (n === undefined) problems.push(`${label}: expected.json has no spec count`);
    else if (specCount !== n) problems.push(`${label}: ${specCount} specs, expected ${n}`);
  }
  return problems;
}
