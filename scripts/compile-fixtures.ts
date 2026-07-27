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
 * Exit 0 = every fixture compiles; exit 1 = at least one does not (errors printed).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const FIXTURES_DIR = join(import.meta.dir, "..", "fixtures");

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
  const candidates = readdirSync(extRoot)
    .filter((d) => d.startsWith("ms-dynamics-smb.al-"))
    .map((d) => join(extRoot, d, "bin", "win32", "alc.exe"))
    .filter((p) => existsSync(p));
  // Lexical sort is wrong across a major bump ("al-9" vs "al-18"), so order by mtime: the newest
  // installed extension is the one a developer is actually building against.
  candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return candidates[0] ?? null;
}

function fixtureProjects(): string[] {
  if (!existsSync(FIXTURES_DIR)) return [];
  return readdirSync(FIXTURES_DIR)
    .map((d) => join(FIXTURES_DIR, d))
    .filter((d) => existsSync(join(d, "app.json")))
    .sort();
}

const alc = findAlc();
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
    `compile-fixtures: no fixture project (a directory with app.json) under ${FIXTURES_DIR}`,
  );
}

console.log(`compile-fixtures: ${projects.length} project(s) with ${alc}\n`);
let failed = 0;
for (const project of projects) {
  const name = project.slice(FIXTURES_DIR.length + 1);
  const packageCache = join(project, ".alpackages");
  if (!existsSync(packageCache)) {
    console.error(`  SKIP  ${name} — no .alpackages (symbols are gitignored; download them first)`);
    continue;
  }
  // Output to a scratch path, never into the fixture: a stray `.app` beside the source is exactly
  // what makes a stale published build hard to notice, which is the bug this script exists for.
  const out = join(tmpdir(), `lethal-fixture-compile-${name}.app`);
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
    continue;
  }
  failed += 1;
  console.error(`  FAIL  ${name} — ${errors.length} error(s)`);
  for (const e of errors.slice(0, 15)) console.error(`          ${e.trim()}`);
  if (errors.length > 15) console.error(`          ... ${errors.length - 15} more`);
}

if (failed > 0) {
  console.error(
    `\ncompile-fixtures: ${failed} fixture project(s) do not compile. A fixture that does not ` +
      "compile cannot be republished, and a live gate that keeps passing against the previously " +
      "published build is measuring something nobody can rebuild (R56).",
  );
  process.exit(1);
}
console.log("\ncompile-fixtures: all fixture projects compile.");
