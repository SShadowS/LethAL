#!/usr/bin/env bun
/**
 * R161's `alc` proof: instrument a branch-slot mutation and compile what comes out.
 *
 *   bun scripts/r161-emit-proof.ts
 *
 * The set census (`r161-slot-census.ts`) proves which SITES are claimed. It says nothing about
 * whether the emitted artifact compiles, and this change is one where that is the whole risk: the
 * component root at a branch-slot site is the enclosing `if`/`case`/loop, so the dispatch chain is
 * spliced INTO a conditional rather than beside one, and a deletion empties a slot the grammar
 * requires a statement in.
 *
 * Measured before `emptiedSlotFiller` existed: three of the four slot shapes emitted a dangling
 * `then`/`do` and would have failed `alc` on the whole project, after the expensive part of a run.
 * So this compiles each shape rather than eyeballing it, and it keeps a NEGATIVE case, where the
 * chain is deliberately emitted without the filler, so that a green result cannot come from a proof
 * that stopped exercising the thing it exists to check.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ALNodeKind, initParser, parseAL, visit, wrapRoot } from "../packages/engine/src/index";
import type { ALSyntaxNode, MutationSpec } from "../packages/engine/src/index";
import { compileSchemataForFile } from "../packages/schemata/src/compile";

function findAlc(): string | null {
  const extRoot = join(homedir(), ".vscode", "extensions");
  if (!existsSync(extRoot)) return null;
  // R167: the AL extension ships BOTH layouts across versions — `bin/win32/alc.exe` on the
  // multi-platform VSIX (18.0.2498801) and `bin/alc.exe` on the per-platform one (18.0.2668733),
  // which has no `win32` directory at all. Probe both, newest first, and take the one that exists.
  const candidates = readdirSync(extRoot)
    .filter((d) => d.startsWith("ms-dynamics-smb.al-"))
    .flatMap((d) => [
      join(extRoot, d, "bin", "win32", "alc.exe"),
      join(extRoot, d, "bin", "alc.exe"),
    ])
    .filter((p) => existsSync(p));
  candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return candidates[0] ?? null;
}

const alc = findAlc();
if (alc === null) {
  console.error(
    "r161-emit-proof: no alc.exe under ~/.vscode/extensions/ms-dynamics-smb.al-* — SKIPPED, not passed.",
  );
  process.exit(0);
}
const packageCache = join(import.meta.dir, "..", "fixtures", "sandbox-app", ".alpackages");
if (!existsSync(packageCache)) {
  console.error("r161-emit-proof: fixtures/sandbox-app/.alpackages missing — SKIPPED, not passed.");
  process.exit(0);
}

/** Object ids inside sandbox-app's own range, so the probe never collides with a real fixture. */
const CASES: readonly { readonly name: string; readonly src: string }[] = [
  {
    name: "deletion in an un-braced then-branch",
    src: `codeunit 79180 "R161 Then" { procedure P(Cond: Boolean) var R: Record "LethAL Sandbox Log"; begin if Cond then R.Init(); R.Insert(); end; }`,
  },
  {
    name: "deletion in an un-braced else-branch",
    src: `codeunit 79181 "R161 Else" { procedure P(Cond: Boolean) var R: Record "LethAL Sandbox Log"; begin if Cond then R.Insert() else R.Init(); end; }`,
  },
  {
    // The shape the first four missed, and the one that failed on real code: a then-branch whose
    // `else` follows INSIDE the root, where an empty statement orphans it (AL0110). The R175 re-run
    // of `do rung1` hit it at three sites in one codeunit and scored all 155 mutants `error`.
    name: "deletion in an un-braced then-branch followed by else",
    src: `codeunit 79186 "R161 Then Else" { procedure P(Cond: Boolean) var R: Record "LethAL Sandbox Log"; begin if Cond then R.Init() else R.Insert(); end; }`,
  },
  {
    name: "deletion in a case-arm body",
    src: `codeunit 79182 "R161 Case" { procedure P(W: Integer) var R: Record "LethAL Sandbox Log"; begin case W of 1: R.Init(); 2: R.Insert(); end; end; }`,
  },
  {
    // A case arm's `;` sits inside the root and survives the splice, so the filler stays empty
    // there even when the case's own `else` follows: `1: ; else` is an empty arm, not an orphan.
    name: "deletion in a case-arm body followed by the case's else",
    src: `codeunit 79187 "R161 Case Else" { procedure P(W: Integer) var R: Record "LethAL Sandbox Log"; begin case W of 1: R.Init(); else R.Insert(); end; end; }`,
  },
  {
    name: "deletion in a while body",
    src: `codeunit 79183 "R161 While" { procedure P(Cond: Boolean) var R: Record "LethAL Sandbox Log"; begin while Cond do R.Init(); end; }`,
  },
  {
    name: "rewrite (not deletion) in an un-braced then-branch",
    src: `codeunit 79184 "R161 Rewrite" { procedure P(Cond: Boolean) var R: Record "LethAL Sandbox Log"; begin if Cond then R.Init(); end; }`,
  },
];

/** The `Mutation Selector` codeunit every instrumented file calls into. Minimal by design: this
 *  proof is about the emitted GUARD SITES compiling, not about the real selector's contents. */
const SELECTOR_AL = `codeunit 79189 "Mutation Selector"
{
    procedure Active(MutantId: Text): Boolean
    begin
        exit(false);
    end;
}`;

/** A table for the probe codeunits to operate on, so the calls resolve. */
const TABLE_AL = `table 79185 "LethAL Sandbox Log"
{
    fields { field(1; "Entry No."; Integer) { } }
    keys { key(PK; "Entry No.") { Clustered = true; } }
}`;

await initParser();

function instrument(src: string, deletion: boolean): string {
  const root = wrapRoot(parseAL(src));
  const specs: MutationSpec[] = [];
  visit(root, (n: ALSyntaxNode) => {
    if (n.kind === ALNodeKind.procedure_call && n.text.includes("Init")) {
      specs.push({
        operatorName: deletion ? "lethal.void-method-call" : "lethal.spike-rewrite",
        operatorVersion: "1.0.0",
        astNodeId: `${n.startIndex}-${n.endIndex}`,
        before: n,
        after: { ...n, text: deletion ? "" : "R.Delete()" } as never,
        parentContext: "statement-position",
      });
    }
  });
  if (specs.length === 0)
    throw new Error("r161-emit-proof: no spec generated — the probe is not testing anything");
  return compileSchemataForFile(src, root, specs, undefined, "probe.al");
}

const scratch = mkdtempSync(join(tmpdir(), "lethal-r161-emit-"));
function compileProject(
  files: readonly { readonly name: string; readonly text: string }[],
): readonly string[] {
  const work = join(scratch, "project");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(join(work, "src"), { recursive: true });
  writeFileSync(
    join(work, "app.json"),
    JSON.stringify(
      {
        id: "b3f1aa9f-6539-4c86-a9d0-ad702b61ac9c",
        name: "R161 Emit Proof",
        publisher: "LethAL",
        version: "1.0.0.0",
        brief: "R161 emit proof",
        description: "R161 emit proof",
        dependencies: [],
        idRanges: [{ from: 79000, to: 79199 }],
        resourceExposurePolicy: {
          allowDebugging: true,
          allowDownloadingSource: true,
          includeSourceInSymbolFile: true,
        },
        runtime: "13.0",
      },
      null,
      2,
    ),
    "utf8",
  );
  for (const f of files) writeFileSync(join(work, "src", f.name), f.text, "utf8");
  const out = join(scratch, "out.app");
  const r = spawnSync(
    alc,
    [`/project:${work}`, `/packagecachepath:${packageCache}`, `/out:${out}`],
    {
      encoding: "utf8",
    },
  );
  rmSync(out, { force: true });
  return `${r.stdout ?? ""}${r.stderr ?? ""}`
    .split(/\r?\n/)
    .filter((l) => /: error [A-Z]{2}\d+:/.test(l))
    .map((l) => l.trim());
}

const base = [
  { name: "Selector.al", text: SELECTOR_AL },
  { name: "Table.al", text: TABLE_AL },
];

let failures = 0;
console.log("r161-emit-proof: compiling instrumented output\n");
for (const c of CASES) {
  const text = instrument(c.src, !c.name.startsWith("rewrite"));
  const errors = compileProject([...base, { name: "Probe.al", text }]);
  if (errors.length === 0) {
    console.log(`  OK    ${c.name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${c.name}`);
    console.log(`        ${errors[0]}`);
  }
}

// NEGATIVE control: the same then-branch deletion with the filler suppressed must be REJECTED.
// Without this, a future edit that stops emitting the `;` would still show five green rows above,
// because a proof that no longer exercises the hazard passes for the wrong reason.
const withoutFiller = instrument(CASES[0]?.src ?? "", true).replace("then ;", "then ");
const negErrors = compileProject([...base, { name: "Probe.al", text: withoutFiller }]);
console.log("");
if (negErrors.length > 0) {
  console.log("  REJECTED  the same emission without the empty-statement filler");
  console.log(`            ${negErrors[0]}`);
} else {
  failures += 1;
  console.log(
    "  ESCAPED   the emission WITHOUT the filler compiled — the filler is not load-bearing,",
  );
  console.log("            so this proof no longer measures what it claims to");
}

// SECOND negative control, for the then-else shape: its empty BLOCK swapped back to the empty
// STATEMENT the other shapes use must be REJECTED (AL0110). That is what says the block is
// load-bearing there, rather than the shape compiling for some other reason.
const thenElse = CASES.find((c) => c.name.endsWith("followed by else"));
if (thenElse === undefined) throw new Error("r161-emit-proof: the then-else shape is missing");
const thenElseEmission = instrument(thenElse.src, true);
const withStatement = thenElseEmission.replace("then begin end else", "then ; else");
if (withStatement === thenElseEmission) {
  throw new Error("r161-emit-proof: the then-else emission does not contain `then begin end else`");
}
const negErrors2 = compileProject([...base, { name: "Probe.al", text: withStatement }]);
if (negErrors2.length > 0) {
  console.log("  REJECTED  the then-else emission with `;` in place of `begin end`");
  console.log(`            ${negErrors2[0]}`);
} else {
  failures += 1;
  console.log(
    "  ESCAPED   the then-else emission with `;` compiled — the empty block is not load-bearing",
  );
}

rmSync(scratch, { recursive: true, force: true });
const negativesHeld = negErrors.length > 0 && negErrors2.length > 0;
console.log(
  `\n${CASES.length - (failures > 0 ? failures : 0)}/${CASES.length} shapes compile; negative controls ${negativesHeld ? "rejected as required" : "ESCAPED"}`,
);
process.exit(failures > 0 ? 1 : 0);
