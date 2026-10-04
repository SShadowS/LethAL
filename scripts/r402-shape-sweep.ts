// R402's compile check: for every shape under scripts/fixtures/r402 and every build, does the
// unmutated source compile, which sites does generateMutationSet emit (or refuse), and does the
// INSTRUMENTED artifact compile? r214-capture.ts writes no artifact and compiles nothing, and the
// S4 defect (a repeat-until `#if` tail misparsed as a statement) only shows in the artifact.
//
//   bun scripts/r402-shape-sweep.ts [--repo <worktree>] [shape-name ...]
//
// Output, per shape and build: src=<ok|FAIL(first error)> specs=<n> [UNDECIDED(<reason>)]
// tags{<var>:<H|->} (remove-assignment hang tags) calls{<void-method-call sites>}
// artifact=<ok|FAIL(first error)|n/a>. Each shape's expected outcome is in
// scripts/fixtures/r402/expected.json (refused with a named reason, or admitted with its spec count
// per build, measured on master). Exit 1 on a source or artifact compile failure, an unexpected
// refusal or admission, a spec count that differs (a missing mutant), a shape with no expectation,
// or a shape filter that matches nothing.
// alc: $ALC, else the AL extension's bin/alc.exe (newest ms-dynamics-smb.al-*, both layouts).
// Symbols come from fixtures/sandbox-symbols/.alpackages (source) and fixtures/sandbox-app's
// (artifact, which also needs LethAL Control).
// Not in `bun run typecheck`, and type-only casts (`as typeof import(...)`) do not fix that (tried
// 2026-10-05, R440). The casts expose four errors that need code changes, not casts: the mutable
// `unknown[]` / `{...}[]` annotations on `res.files` and `res.preprocExcluded` are not assignable
// from the readonly package types; `res.identityOrdinals` does not exist on the current
// `MutationSetResult`; and, once typed, `writeInstrumentedProject` requires `identityOrdinals`, which
// the tolerant `--repo` form (older trees may lack `identityOrdinalsOf`) makes optional. Typing it
// means dropping `--repo` support for old trees, a decision for the owner, not a cast.
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const repoAt = args.indexOf("--repo");
const repo = repoAt >= 0 ? (args[repoAt + 1] ?? "") : join(import.meta.dir, "..");
const only = args.filter((a, i) => a !== "--repo" && args[i - 1] !== "--repo");
const here = join(import.meta.dir, "..");

const { initParser } = await import(`${repo}/packages/engine/src/index.ts`);
const { generateMutationSet, identityOrdinalsOf, operatorTiers } = await import(
  `${repo}/packages/runner/src/orchestrator.ts`
);
const { writeInstrumentedProject } = await import(`${repo}/packages/schemata/src/index.ts`);
const { injectControlDependency } = await import(`${repo}/packages/runner/src/harness.ts`);

function findAlc(): string {
  const env = process.env.ALC;
  if (env !== undefined && env !== "") return env;
  const ext = join(homedir(), ".vscode", "extensions");
  const dirs = readdirSync(ext)
    .filter((d) => d.startsWith("ms-dynamics-smb.al-"))
    .sort()
    .reverse();
  for (const d of dirs)
    for (const p of [join(ext, d, "bin", "alc.exe"), join(ext, d, "bin", "win32", "alc.exe")])
      if (existsSync(p)) return p;
  throw new Error("r402-shape-sweep: no alc.exe found; set ALC");
}
const ALC = findAlc();

const compiles = (dir: string, set: readonly string[]): string => {
  const out = join(dir, "o.app");
  const r = spawnSync(
    ALC,
    [
      `/project:${dir}`,
      `/packagecachepath:${join(dir, ".alpackages")}`,
      ...(set.length > 0 ? [`/define:${set.join(",")}`] : []),
      `/out:${out}`,
    ],
    { encoding: "utf8" },
  );
  if (r.status === 0 && existsSync(out)) return "ok";
  const first = `${r.stdout}`.split(/\r?\n/).find((l) => /error AL/.test(l)) ?? "?";
  return `FAIL(${first.replace(/^.*error /, "")})`;
};

await initParser();
const appJson = readFileSync(join(here, "fixtures/sandbox-symbols/app.json"), "utf8");
const shapesDir = join(here, "scripts/fixtures/r402");
const builds: readonly (readonly string[])[] = [
  [],
  ["LETHALX"],
  ["LETHALY"],
  ["LETHALX", "LETHALY"],
];
type Expected = { readonly refused?: string; readonly specs?: readonly number[] };
const expected = JSON.parse(readFileSync(join(shapesDir, "expected.json"), "utf8")) as Record<
  string,
  Expected
>;
const shapeFiles = readdirSync(shapesDir)
  .filter((n) => n.endsWith(".al"))
  .sort()
  .filter((f) => only.length === 0 || only.includes(f.replace(/\.al$/, "")));
if (shapeFiles.length === 0) {
  console.error(`r402-shape-sweep: no shape matches ${only.join(", ")}`);
  process.exit(1);
}
const scratch = mkdtempSync(join(tmpdir(), "r402-sweep-"));
const problems: string[] = [];
let cases = 0;
let artifacts = 0;
let refusedCases = 0;
try {
  for (const f of shapeFiles) {
    const name = f.replace(/\.al$/, "");
    const want = expected[name];
    if (want === undefined) {
      problems.push(`${name}: no entry in expected.json`);
      continue;
    }
    const text = readFileSync(join(shapesDir, f), "utf8");
    console.log(`=== ${name}`);
    for (const [bi, set] of builds.entries()) {
      const src = join(scratch, "src");
      rmSync(src, { recursive: true, force: true });
      mkdirSync(join(src, "src"), { recursive: true });
      writeFileSync(join(src, "app.json"), appJson);
      writeFileSync(join(src, "src", "Shape.Codeunit.al"), text);
      cpSync(join(here, "fixtures/sandbox-symbols/.alpackages"), join(src, ".alpackages"), {
        recursive: true,
      });
      const res = await generateMutationSet(src, { preprocessorSymbols: set, emit: () => {} });
      const specs = res.files.flatMap((x: { specs: unknown[] }) => x.specs) as {
        operatorName: string;
        hangCapable?: string;
        before: { text: string };
      }[];
      const undecided = (res.preprocExcluded as { reason: string; detail?: string }[])
        .filter((e) => e.reason === "preproc-undecided")
        .map((e) => e.detail ?? "");
      const tags = specs
        .filter((s) => s.operatorName === "lethal.remove-assignment")
        .map((s) => `${s.before.text.split(":=")[0]?.trim()}:${s.hangCapable ? "H" : "-"}`)
        .join(" ");
      const calls = specs
        .filter((s) => s.operatorName === "lethal.void-method-call")
        .map((s) => s.before.text.replace(/\s+/g, " "))
        .join("|");
      let art = "n/a";
      if (specs.length > 0) {
        const out = join(scratch, "art");
        rmSync(out, { recursive: true, force: true });
        // R-307 made run-wide `identityOrdinals` a required input (numbered by `identityOrdinalsOf`,
        // the call `runSession` makes). `--repo` may point at an older tree: one between R374 and
        // R400 returns them on the set, and one without R374 has neither (same as r214-capture.ts).
        const identityOrdinals = identityOrdinalsOf?.(res) ?? res.identityOrdinals;
        await writeInstrumentedProject({
          targetDir: out,
          files: res.files,
          ...(identityOrdinals !== undefined ? { identityOrdinals } : {}),
          selectorIds: { selectorId: 79647, controlId: 79648, tableId: 79649 },
          artifactId: "0123456789abcdef0123456789abcdef",
          targetAppId: "fda67638-2fee-4a1c-94bd-bc37c357f0d9",
          operatorTiers,
        });
        writeFileSync(
          join(out, "app.json"),
          JSON.stringify(injectControlDependency(JSON.parse(appJson))),
        );
        cpSync(join(here, "fixtures/sandbox-app/.alpackages"), join(out, ".alpackages"), {
          recursive: true,
        });
        art = compiles(out, set);
        artifacts++;
        if (art !== "ok") problems.push(`${name} [${set.join(",")}]: artifact ${art}`);
      }
      cases++;
      const srcResult = compiles(src, set);
      if (srcResult !== "ok") problems.push(`${name} [${set.join(",")}]: source ${srcResult}`);
      const label = `${name} [${set.join(",")}]`;
      if (want.refused !== undefined) {
        refusedCases++;
        if (undecided.length !== 1 || !(undecided[0] ?? "").startsWith(want.refused)) {
          problems.push(
            `${label}: expected refusal "${want.refused}", got ${JSON.stringify(undecided)}`,
          );
        }
        if (specs.length !== 0)
          problems.push(`${label}: refused shape emitted ${specs.length} specs`);
      } else {
        if (undecided.length > 0)
          problems.push(`${label}: unexpected refusal ${JSON.stringify(undecided)}`);
        const n = want.specs?.[bi];
        if (n === undefined) problems.push(`${label}: expected.json has no spec count`);
        else if (specs.length !== n)
          problems.push(`${label}: ${specs.length} specs, expected ${n}`);
      }
      console.log(
        `  [${set.join(",")}] src=${srcResult} specs=${specs.length} ${undecided.length > 0 ? `UNDECIDED(${undecided.join(";")}) ` : ""}tags{${tags}} calls{${calls}} artifact=${art}`,
      );
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(
  `cases ${cases}: ${artifacts} artifacts compiled, ${refusedCases} refused (no artifact); problems ${problems.length}`,
);
for (const p of problems) console.log(`  PROBLEM ${p}`);
process.exit(problems.length > 0 ? 1 : 0);
