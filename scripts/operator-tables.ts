#!/usr/bin/env bun
/**
 * Generates the operator tables in `design.md` §4 and `README.md` from the REGISTRY.
 *
 * WHY THIS EXISTS. `design.md` §4's tables were hand-written and drifted: on 2026-08-19 they still
 * listed `RemoveSetLoadFields` and `EmptyTrigger`, neither of which is built (the first is refused
 * on cost, with the measurement recorded in `builtin-tier2/src/index.ts`), and omitted four
 * operators that ship: `swap-call-arguments`, `swap-find-direction`, `validate-to-assign` and
 * `flip-filter-literal`. A reader deciding what the product does was reading a plan, not the
 * product. `README.md` had no operator list at all.
 *
 * A hand-maintained second copy of the registry rots. This makes the copy generated and the drift
 * mechanical: `scripts/operator-tables.test.ts` fails when a file disagrees with the registry, the
 * same shape `roadmap-index.ts` uses for `ROADMAP.md`.
 *
 *   bun scripts/operator-tables.ts            # rewrite the marked blocks
 *   bun scripts/operator-tables.ts --check    # exit 1 if a file is not what the registry implies
 *
 * Everything in a row except the last column comes from the operator object. The last column, "what
 * weak test it catches", is the one fact the registry cannot supply and lives in
 * `scripts/operator-blurbs.json`; an operator missing from that file is a hard refusal, never a
 * blank cell.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tier1Operators } from "../packages/builtin-tier1/src/index";
import { tier2Operators } from "../packages/builtin-tier2/src/index";
import type { ConformanceCase, MutationOperator } from "../packages/operator-sdk/src/index";

const REPO_ROOT = join(import.meta.dir, "..");
const BLURBS_FILE = join(REPO_ROOT, "scripts", "operator-blurbs.json");

/** Files carrying a generated block, and which tiers each wants. */
const TARGETS: readonly { readonly file: string; readonly markers: readonly string[] }[] = [
  { file: "design.md", markers: ["tier1", "tier2"] },
  { file: "README.md", markers: ["tier1", "tier2"] },
];

interface BlurbFile {
  readonly blurbs: Record<string, string>;
}

function loadBlurbs(): Record<string, string> {
  const parsed = JSON.parse(readFileSync(BLURBS_FILE, "utf8")) as BlurbFile;
  if (typeof parsed.blurbs !== "object" || parsed.blurbs === null) {
    throw new Error(`${BLURBS_FILE}: no "blurbs" object`);
  }
  return parsed.blurbs;
}

/**
 * A verified before/after pair for the operator, taken from its own conformance suite.
 *
 * Deliberately NOT hand-written prose: `runConformance` executes these cases at registration, so an
 * example that stopped being true fails the operator's own gate rather than quietly misleading a
 * reader. An operator whose conformance suite yields no spec is REFUSED here — the alternative is a
 * table row illustrating nothing, which is worse than a build failure.
 */
function exampleOf(op: MutationOperator): string {
  for (const c of op.conformanceTests as readonly ConformanceCase[]) {
    const first = c.expectedSpecs[0];
    if (first === undefined) continue;
    const after = first.afterText === "" ? "_(deleted)_" : `\`${first.afterText}\``;
    return `\`${first.beforeText}\` → ${after}`;
  }
  throw new Error(
    `operator-tables: ${op.name} has no conformance case carrying a spec, so there is no VERIFIED ` +
      "example to publish. Add one to the operator's conformanceTests rather than hand-writing a row.",
  );
}

function tableFor(operators: readonly MutationOperator[], blurbs: Record<string, string>): string {
  const lines = [
    "| Operator | Version | Example | What weak test it catches |",
    "|---|---|---|---|",
  ];
  for (const op of operators) {
    const blurb = blurbs[op.name];
    if (blurb === undefined) {
      throw new Error(
        `operator-tables: ${op.name} is registered but has no entry in scripts/operator-blurbs.json. ` +
          "Say what weak test it catches; a blank cell is not an acceptable default.",
      );
    }
    lines.push(`| \`${op.name}\` | ${op.version} | ${exampleOf(op)} | ${blurb} |`);
  }
  return lines.join("\n");
}

function blockFor(marker: string, blurbs: Record<string, string>): string {
  if (marker === "tier1") return tableFor(tier1Operators, blurbs);
  if (marker === "tier2") return tableFor(tier2Operators, blurbs);
  throw new Error(`operator-tables: unknown marker "${marker}"`);
}

/** Replaces the text between `<!-- operators: X -->` and `<!-- /operators: X -->`, exclusive. */
export function renderInto(source: string, marker: string, block: string): string {
  const open = `<!-- operators: ${marker} -->`;
  const close = `<!-- /operators: ${marker} -->`;
  const openAt = source.indexOf(open);
  const closeAt = source.indexOf(close);
  if (openAt < 0 || closeAt < 0) {
    throw new Error(`operator-tables: missing ${open} / ${close} marker pair`);
  }
  if (closeAt < openAt) {
    throw new Error(`operator-tables: ${close} appears before ${open}`);
  }
  return `${source.slice(0, openAt + open.length)}\n${block}\n${source.slice(closeAt)}`;
}

export function expectedContent(file: string, markers: readonly string[]): string {
  const blurbs = loadBlurbs();
  let text = readFileSync(join(REPO_ROOT, file), "utf8");
  for (const marker of markers) text = renderInto(text, marker, blockFor(marker, blurbs));
  return text;
}

export function staleTargets(): readonly string[] {
  return TARGETS.filter((t) => {
    const current = readFileSync(join(REPO_ROOT, t.file), "utf8");
    return expectedContent(t.file, t.markers) !== current;
  }).map((t) => t.file);
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  const stale = staleTargets();
  if (check) {
    if (stale.length > 0) {
      console.error(
        `operator-tables: ${stale.join(", ")} disagree(s) with the operator registry. The tables ` +
          "are GENERATED — run 'bun scripts/operator-tables.ts'.",
      );
      process.exit(1);
    }
    console.log(`operator-tables: ${TARGETS.length} file(s) match the registry`);
  } else {
    for (const t of TARGETS) {
      writeFileSync(join(REPO_ROOT, t.file), expectedContent(t.file, t.markers), "utf8");
    }
    const total = tier1Operators.length + tier2Operators.length;
    console.log(
      `operator-tables: wrote ${TARGETS.map((t) => t.file).join(", ")} — ${total} operator(s) ` +
        `(tier 1: ${tier1Operators.length}, tier 2: ${tier2Operators.length})`,
    );
  }
}
