/**
 * R56: offline `alc` compile of every AL fixture project.
 *
 * This exists because a DOCS-ONLY commit (`76dfe48`, rewriting a comment inside
 * `InsertDoublesAmountWeak`) deleted the procedure's statements and its closing `end;` along with
 * the comment it meant to replace. `fixtures/sandbox-data-tests` stopped compiling — and
 * `itest:tables` kept passing for days, because LethAL publishes the TARGET on every run but
 * treats publishing the TEST APP as the user's own workflow. The gate was measuring a stale
 * published build while the source was broken, and the frozen baseline it asserted described
 * nothing anyone could rebuild.
 *
 * R31's stale-test-app detector structurally cannot catch that shape: it fires when the server has
 * no result for a DISCOVERED test, and here the server held an older, WORKING build of every test,
 * so nothing it measures had diverged.
 *
 * `bun run typecheck` covers the TypeScript. Nothing covered the AL. This does, in seconds.
 *
 * Usage:  bun scripts/compile-fixtures.ts
 *         bun scripts/compile-fixtures.ts --inventory <out.json>
 * Exit 0 = every fixture compiles; exit 1 = at least one does not (errors printed).
 *
 * ## Inventory mode, and why exit 0 is not enough for a program
 *
 * Read by a human this script is honest: it says SKIPPED when `alc` is missing, and SKIP per
 * project when symbols are absent. Read by a PROGRAM it is not, because all of those exit 0
 * (R223). A caller cannot tell "every fixture compiles" from "nothing was compiled".
 *
 * `--inventory` writes what was actually done: the resolved compiler, and for every project its
 * version, its source hash and whether it compiled. In that mode a missing `alc` is an ERROR
 * rather than a friendly skip, because a caller that asked for an inventory and got none has
 * learned nothing at all.
 *
 * The script reports; it does not judge. Which skipped project matters depends on what a change
 * touched, and this script does not know the diff. So every project appears with its status and
 * the caller decides.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { sourceHash } from "./lib/source-hash.ts";

/**
 * Every root holding AL projects that must keep compiling. `examples/` joined `fixtures/` when the
 * gift card demo landed, and for the same reason R56 gives: the demo app is published to a live
 * server from a stage, so "it stopped compiling" must be a red check here rather than a discovery
 * in front of a room.
 */
const PROJECT_ROOTS = [
  join(import.meta.dir, "..", "fixtures"),
  join(import.meta.dir, "..", "examples"),
];

/**
 * Newest `alc.exe` from the installed AL VS Code extension.
 *
 * Deliberately NOT reusing `cli.ts`'s `defaultAlToolPaths`: that one also demands `altool.exe`
 * (the publisher), which this script never needs, and failing here for a missing publisher would
 * make a compile check unrunnable for a reason unrelated to compiling. R21 was the same shape.
 */
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
  // Lexical sort is wrong across a major bump ("al-9" vs "al-18"), so order by mtime: the newest
  // installed extension is the one a developer is actually building against.
  candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return candidates[0] ?? null;
}

function fixtureProjects(): string[] {
  return PROJECT_ROOTS.filter((root) => existsSync(root)).flatMap((root) =>
    readdirSync(root)
      .map((d) => join(root, d))
      .filter((d) => existsSync(join(d, "app.json")))
      .sort(),
  );
}

/** `fixtures/sandbox-app` rather than `sandbox-app`: with two roots, the bare directory name no
 *  longer says which project failed. */
function projectLabel(project: string): string {
  const root = PROJECT_ROOTS.find((r) => project.startsWith(r));
  if (root === undefined) return project;
  return `${root.split(/[\\/]/).pop()}/${project.slice(root.length + 1)}`;
}

/** One row of the inventory: what this project is, and whether it was actually compiled. */
interface InventoryProject {
  readonly project: string;
  readonly version: string;
  readonly sourceHash: string;
  readonly status: "compiled" | "no-symbols" | "failed";
}

const inventoryIdx = process.argv.indexOf("--inventory");
const inventoryPath = inventoryIdx >= 0 ? process.argv[inventoryIdx + 1] : undefined;
if (inventoryIdx >= 0 && (inventoryPath === undefined || inventoryPath.startsWith("--"))) {
  console.error("compile-fixtures: --inventory needs a path to write");
  process.exit(1);
}
const inventory: InventoryProject[] = [];

function appVersion(project: string): string {
  const raw = readFileSync(join(project, "app.json"), "utf8").replace(/^﻿/, "");
  return String((JSON.parse(raw) as { version?: unknown }).version ?? "");
}

const alc = findAlc();
if (alc === null && inventoryPath !== undefined) {
  // Deliberately NOT the friendly skip below. A caller that asked for an inventory and got exit 0
  // with no inventory has learned nothing, and treating that as a pass is the exact shape R223 is
  // about.
  console.error(
    "compile-fixtures: no alc.exe found, and --inventory was requested. An absent inventory is " +
      "not a pass.",
  );
  process.exit(1);
}
if (alc === null) {
  // Not a failure: a machine without the AL extension cannot run this check, and pretending it
  // passed would be worse than saying it did not run. Exit 0 so it never blocks a TypeScript-only
  // contributor, but say so loudly enough that nobody reads silence as success.
  console.error(
    "compile-fixtures: no alc.exe found under ~/.vscode/extensions/ms-dynamics-smb.al-* — " +
      "SKIPPED, not passed. Install the AL Language extension to run this check.",
  );
  process.exit(0);
}

const projects = fixtureProjects();
if (projects.length === 0) {
  throw new Error(
    `compile-fixtures: no AL project (a directory with app.json) under ${PROJECT_ROOTS.join(" or ")}`,
  );
}

console.log(`compile-fixtures: ${projects.length} project(s) with ${alc}\n`);
let failed = 0;
for (const project of projects) {
  const name = projectLabel(project);
  const packageCache = join(project, ".alpackages");
  const version = appVersion(project);
  if (!existsSync(packageCache)) {
    console.error(`  SKIP  ${name} — no .alpackages (symbols are gitignored; download them first)`);
    inventory.push({
      project: name,
      version,
      sourceHash: sourceHash(project),
      status: "no-symbols",
    });
    continue;
  }
  // Output to a scratch path, never into the fixture: a stray `.app` beside the source is exactly
  // what makes a stale published build hard to notice, which is the bug this script exists for.
  //
  // The separator in `name` (`examples/gift-card`) is flattened, because a `/` here would aim the
  // compiler at a subdirectory of the temp dir that nothing creates. A failure to WRITE is not a
  // compile error, so the run could end up reporting OK for a compile whose output went nowhere —
  // the "passes for the wrong reason" shape this repository keeps finding.
  const out = join(tmpdir(), `lethal-fixture-compile-${name.replace(/[\\/]/g, "-")}.app`);
  const r = spawnSync(
    alc,
    [`/project:${project}`, `/packagecachepath:${packageCache}`, `/out:${out}`],
    {
      encoding: "utf8",
    },
  );
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const errors = output.split(/\r?\n/).filter((l) => /: error [A-Z]{2}\d+:/.test(l));
  try {
    rmSync(out, { force: true });
  } catch {
    // A leftover scratch artifact is not worth failing the check over.
  }
  if (r.status === 0 && errors.length === 0) {
    console.log(`  OK    ${name}`);
    inventory.push({ project: name, version, sourceHash: sourceHash(project), status: "compiled" });
    continue;
  }
  inventory.push({ project: name, version, sourceHash: sourceHash(project), status: "failed" });
  failed += 1;
  console.error(`  FAIL  ${name} — ${errors.length} error(s)`);
  for (const e of errors.slice(0, 15)) console.error(`          ${e.trim()}`);
  if (errors.length > 15) console.error(`          ... ${errors.length - 15} more`);
}

if (inventoryPath !== undefined) {
  // Written even when a project failed to compile, because the caller needs to know WHICH one and
  // at what source. An inventory only on success would leave the interesting case unreported.
  writeFileSync(
    inventoryPath,
    `${JSON.stringify({ alc, projects: inventory }, null, 2)}\n`,
    "utf8",
  );
  console.log(`compile-fixtures: inventory of ${inventory.length} project(s) -> ${inventoryPath}`);
}

if (failed > 0) {
  console.error(
    `\ncompile-fixtures: ${failed} fixture project(s) do not compile. A fixture that does not compile cannot be republished, and a live gate that keeps passing against the previously published build is measuring something nobody can rebuild (R56).`,
  );
  process.exit(1);
}
console.log("\ncompile-fixtures: all fixture projects compile.");
