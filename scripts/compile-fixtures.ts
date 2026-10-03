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
 *         bun scripts/compile-fixtures.ts --require-symbol-sets
 *           R321: a project that declares symbol sets (symbol-sets.json) may not be skipped for
 *           missing symbols.
 *         bun scripts/compile-fixtures.ts --require-all
 *           Exit 1 when ANY project was skipped (no alc, missing .alpackages); prints a
 *           compiled/skipped inventory either way. On Linux a missing alc always exits 1.
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
import { readSymbolSets } from "./lib/symbol-sets.ts";

/**
 * Every root holding AL projects that must keep compiling. `examples/` joined `fixtures/` when the
 * gift card demo landed, and for the same reason R56 gives: the demo app is published to a live
 * server from a stage, so "it stopped compiling" must be a red check here rather than a discovery
 * in front of a room.
 */
const projectRoots = (repo: string): string[] => [join(repo, "fixtures"), join(repo, "examples")];
const PROJECT_ROOTS = projectRoots(join(import.meta.dir, ".."));

/**
 * Newest `alc.exe` from the installed AL VS Code extension.
 *
 * Deliberately NOT reusing `cli.ts`'s `defaultAlToolPaths`: that one also demands `altool.exe`
 * (the publisher), which this script never needs, and failing here for a missing publisher would
 * make a compile check unrunnable for a reason unrelated to compiling. R21 was the same shape.
 */
export function findAlc(opts: {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
  exists: (p: string) => boolean;
  /** Extension folders, newest first. */
  extensionDirs: string[];
}): string | null {
  const win = opts.platform === "win32";
  // Paths are joined with "/" on purpose: Windows accepts it, and the result is the same string on
  // every platform, which keeps this function testable.
  const fromEnv = opts.env.LETHAL_ALC_DIR;
  if (fromEnv !== undefined && fromEnv !== "") {
    const p = `${fromEnv.replace(/[\\/]+$/, "")}/${win ? "alc.exe" : "alc"}`;
    if (opts.exists(p)) return p;
  }
  // R167: the AL extension ships BOTH layouts across versions — `bin/win32/alc.exe` on the
  // multi-platform VSIX (18.0.2498801) and `bin/alc.exe` on the per-platform one (18.0.2668733),
  // which has no `win32` directory at all. Probe both, newest first, and take the one that exists.
  // Linux has one layout, `bin/linux/alc`; the universal VSIX's `bin/alc.exe` is a Windows launcher
  // and is never taken there.
  for (const dir of opts.extensionDirs) {
    const probes = win
      ? [`${dir}/bin/win32/alc.exe`, `${dir}/bin/alc.exe`]
      : [`${dir}/bin/linux/alc`];
    for (const p of probes) if (opts.exists(p)) return p;
  }
  return null;
}

/** Extension folders under `~/.vscode/extensions`, newest first. */
function extensionDirs(home: string): string[] {
  const extRoot = join(home, ".vscode", "extensions");
  if (!existsSync(extRoot)) return [];
  // Lexical sort is wrong across a major bump ("al-9" vs "al-18"), so order by mtime: the newest
  // installed extension is the one a developer is actually building against.
  return readdirSync(extRoot)
    .filter((d) => d.startsWith("ms-dynamics-smb.al-"))
    .map((d) => join(extRoot, d).replace(/\\/g, "/"))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

interface Row {
  project: string;
  status: "compiled" | "skipped" | "failed";
  why?: string;
}

/** `--require-all`: one line per skipped project; non-empty means exit 1. (A failed project
 *  already exits 1 through the failure count.) */
export function requireAll(rows: readonly Row[]): string[] {
  return rows
    .filter((r) => r.status === "skipped")
    .map((r) => `${r.project}: ${r.why ?? "skipped"}`);
}

/** The compiled/skipped/failed inventory `--require-all` prints. */
export function inventoryReport(rows: readonly Row[]): {
  compiled: number;
  skipped: number;
  failed: number;
  lines: string[];
} {
  const count = (s: Row["status"]) => rows.filter((r) => r.status === s).length;
  const compiled = count("compiled");
  const skipped = count("skipped");
  const failed = count("failed");
  return {
    compiled,
    skipped,
    failed,
    lines: [
      `\ncompile-fixtures: compiled ${compiled}, skipped ${skipped}, failed ${failed}`,
      ...rows.map((r) => `  ${r.status.toUpperCase().padEnd(8)} ${r.project}`),
    ],
  };
}

/** Every AL project (a directory with `app.json`) under the repo's project roots. `kraken-secrets.ts`
 *  reuses it so the symbol tar and this compile check cannot disagree on what a fixture is. */
export function fixtureProjects(repo?: string): string[] {
  return (repo === undefined ? PROJECT_ROOTS : projectRoots(repo))
    .filter((root) => existsSync(root))
    .flatMap((root) =>
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
  /** R321: present only for a project with a `symbol-sets.json`, one entry per declared build. */
  readonly builds?: readonly {
    readonly symbols: readonly string[];
    readonly status: "compiled" | "failed";
  }[];
}

function main(): void {
  const inventoryIdx = process.argv.indexOf("--inventory");
  const inventoryPath = inventoryIdx >= 0 ? process.argv[inventoryIdx + 1] : undefined;
  if (inventoryIdx >= 0 && (inventoryPath === undefined || inventoryPath.startsWith("--"))) {
    console.error("compile-fixtures: --inventory needs a path to write");
    process.exit(1);
  }
  const inventory: InventoryProject[] = [];

  /**
   * R321. Off by default: the fixture edit hook runs this script in every worktree, and a project's
   * `.alpackages` is gitignored, so refusing a skip by default would block every fixture edit where
   * nobody staged this pair's symbols. The R321 check always passes it.
   */
  const requireSymbolSets = process.argv.includes("--require-symbol-sets");

  function appVersion(project: string): string {
    const raw = readFileSync(join(project, "app.json"), "utf8").replace(/^﻿/, "");
    return String((JSON.parse(raw) as { version?: unknown }).version ?? "");
  }

  const requireEvery = process.argv.includes("--require-all");
  const alc = findAlc({
    platform: process.platform,
    env: process.env,
    home: homedir(),
    exists: existsSync,
    extensionDirs: extensionDirs(homedir()),
  });
  if (alc === null && (process.platform !== "win32" || requireEvery)) {
    // Never a skip on Linux: the container's gates read exit 0 as "compiled". Same for
    // --require-all anywhere.
    console.error(
      process.platform === "win32"
        ? "compile-fixtures: no alc.exe found, and --require-all refuses a skip."
        : "compile-fixtures: no Linux alc found (set LETHAL_ALC_DIR)",
    );
    if (requireEvery) {
      const rows = fixtureProjects().map((p) => ({
        project: projectLabel(p),
        status: "skipped" as const,
        why: "no alc",
      }));
      for (const l of inventoryReport(rows).lines) console.log(l);
    }
    process.exit(1);
  }
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
    // R321: a project that declares symbol sets is compiled once per set, because an `#if` arm that
    // only one set compiles is otherwise never compiled at all, and a broken one passes.
    const declaredSets = readSymbolSets(project);
    if (!existsSync(packageCache)) {
      if (declaredSets !== undefined && requireSymbolSets) {
        failed += 1;
        console.error(
          `  FAIL  ${name}: declares symbol sets but has no .alpackages, and --require-symbol-sets refuses a skip`,
        );
      } else {
        console.error(
          `  SKIP  ${name}: no .alpackages (symbols are gitignored; download them first)`,
        );
      }
      inventory.push({
        project: name,
        version,
        sourceHash: sourceHash(project),
        status: "no-symbols",
      });
      continue;
    }
    const builds: { symbols: readonly string[]; status: "compiled" | "failed" }[] = [];
    for (const symbols of declaredSets ?? [[]]) {
      const label = declaredSets !== undefined ? `${name} [${symbols.join(",")}]` : name;
      // Output to a scratch path, never into the fixture: a stray `.app` beside the source is exactly
      // what makes a stale published build hard to notice, which is the bug this script exists for.
      // The separator in `name` is flattened, because a `/` here would aim the compiler at a
      // subdirectory of the temp dir that nothing creates.
      const suffix = symbols.length > 0 ? `-${symbols.join("-")}` : "";
      const out = join(
        tmpdir(),
        `lethal-fixture-compile-${name.replace(/[\\/]/g, "-")}${suffix}.app`,
      );
      const r = spawnSync(
        alc,
        [
          `/project:${project}`,
          `/packagecachepath:${packageCache}`,
          // Omitted for the empty set, as `ArtifactCompiler` does: `/define:` with no value is a
          // different thing to say to a compiler than not saying it.
          ...(symbols.length > 0 ? [`/define:${symbols.join(",")}`] : []),
          `/out:${out}`,
        ],
        { encoding: "utf8" },
      );
      const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      const errors = output.split(/\r?\n/).filter((l) => /: error [A-Z]{2}\d+:/.test(l));
      try {
        rmSync(out, { force: true });
      } catch {
        // A leftover scratch artifact is not worth failing the check over.
      }
      if (r.status === 0 && errors.length === 0) {
        console.log(`  OK    ${label}`);
        builds.push({ symbols, status: "compiled" });
        continue;
      }
      builds.push({ symbols, status: "failed" });
      failed += 1;
      console.error(`  FAIL  ${label}: ${errors.length} error(s)`);
      for (const e of errors.slice(0, 15)) console.error(`          ${e.trim()}`);
      if (errors.length > 15) console.error(`          ... ${errors.length - 15} more`);
    }
    inventory.push({
      project: name,
      version,
      sourceHash: sourceHash(project),
      status: builds.some((b) => b.status === "failed") ? "failed" : "compiled",
      ...(declaredSets !== undefined ? { builds } : {}),
    });
  }

  if (inventoryPath !== undefined) {
    // Written even when a project failed to compile, because the caller needs to know WHICH one and
    // at what source. An inventory only on success would leave the interesting case unreported.
    writeFileSync(
      inventoryPath,
      `${JSON.stringify({ alc, projects: inventory }, null, 2)}\n`,
      "utf8",
    );
    console.log(
      `compile-fixtures: inventory of ${inventory.length} project(s) -> ${inventoryPath}`,
    );
  }

  let skipped: string[] = [];
  if (requireEvery) {
    const rows = inventory.map((p) => ({
      project: p.project,
      status:
        p.status === "no-symbols"
          ? ("skipped" as const)
          : p.status === "failed"
            ? ("failed" as const)
            : ("compiled" as const),
      ...(p.status === "no-symbols" ? { why: "no .alpackages" } : {}),
    }));
    skipped = requireAll(rows);
    for (const l of inventoryReport(rows).lines) console.log(l);
  }

  if (failed > 0) {
    console.error(
      `\ncompile-fixtures: ${failed} fixture build(s) do not compile. A fixture that does not compile cannot be republished, and a live gate that keeps passing against the previously published build is measuring something nobody can rebuild (R56).`,
    );
    process.exit(1);
  }
  if (skipped.length > 0) {
    console.error(
      `\ncompile-fixtures: --require-all refuses ${skipped.length} skipped project(s):`,
    );
    for (const s of skipped) console.error(`  ${s}`);
    process.exit(1);
  }
  console.log("\ncompile-fixtures: all fixture projects compile.");
}

if (import.meta.main) main();
