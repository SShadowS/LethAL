// R402's compile check: for every shape under scripts/fixtures/r402 and every build, does the
// unmutated source compile, which sites does generateMutationSet emit (or refuse), and does the
// INSTRUMENTED artifact compile? r214-capture.ts writes no artifact and compiles nothing, and the
// S4 defect (a repeat-until `#if` tail misparsed as a statement) only shows in the artifact.
//
//   bun scripts/r402-shape-sweep.ts [--repo <worktree>] [shape-name ...]
//
// Output, per shape and build: src=<ok|FAIL(first error)> specs=<n> [UNDECIDED(<reason>)]
// tags{<var>:<H|->} (remove-assignment hang tags) calls{<void-method-call sites>}
// artifact=<ok|FAIL(first error)|n/a>. Exit 1 when any emitted artifact fails to compile.
// alc: $ALC, else the AL extension's bin/alc.exe (newest ms-dynamics-smb.al-*, both layouts).
// Symbols come from fixtures/sandbox-symbols/.alpackages (source) and fixtures/sandbox-app's
// (artifact, which also needs LethAL Control). Not in `bun run typecheck` (dynamic imports by --repo).
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
const { generateMutationSet, operatorTiers } = await import(
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
const scratch = mkdtempSync(join(tmpdir(), "r402-sweep-"));
let artifactFailures = 0;
try {
  for (const f of readdirSync(shapesDir)
    .filter((n) => n.endsWith(".al"))
    .sort()) {
    const name = f.replace(/\.al$/, "");
    if (only.length > 0 && !only.includes(name)) continue;
    const text = readFileSync(join(shapesDir, f), "utf8");
    console.log(`=== ${name}`);
    for (const set of builds) {
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
        await writeInstrumentedProject({
          targetDir: out,
          files: res.files,
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
        if (art !== "ok") artifactFailures++;
      }
      console.log(
        `  [${set.join(",")}] src=${compiles(src, set)} specs=${specs.length} ${undecided.length > 0 ? `UNDECIDED(${undecided.join(";")}) ` : ""}tags{${tags}} calls{${calls}} artifact=${art}`,
      );
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`artifact compile failures: ${artifactFailures}`);
process.exit(artifactFailures > 0 ? 1 : 0);
