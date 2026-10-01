// R364's alc check: does a master mutant next to a declaration in an inactive `#if` arm compile?
//
//   bun scripts/r364-mut-compile.ts [<project-dir>...] [--repo <worktree>]
//
// With no project, runs every repro under packages/runner/tests/fixtures/r364 (t1..t3 and their
// no-directive controls under ctl/). For each project: the unmutated build per symbol set, then
// per RAW master spec (generateMutationSet on the checked-out engine) and per set:
//   compiled     the copy with ONLY that mutant applied compiles under the set (alc);
//   compiledOut  the copy with that mutant's span replaced by an undefined identifier ALSO
//                compiles, i.e. alc never built the site under that set, so `compiled` is a
//                trivial pass there and proves nothing about the mutant.
// Output is TSV: repro, file:line, operator, span, set, compiled, compiledOut.
// alc: $ALC, else the AL extension's bin/alc.exe (newest ms-dynamics-smb.al-*, both layouts).
// Not in `bun run typecheck` (dynamic imports by --repo, like r214-capture.ts).
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
const positional = args.filter((a, i) => a !== "--repo" && args[i - 1] !== "--repo");
const fixtures = join(repo, "packages/runner/tests/fixtures/r364");
const projects =
  positional.length > 0
    ? positional
    : [
        ...["t1-return-type", "t2-swap-args", "t3-dup-member"].map((n) => join(fixtures, n)),
        ...["t1-return-type", "t2-swap-args", "t3-dup-member"].map((n) => join(fixtures, "ctl", n)),
      ];

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
  throw new Error("r364-mut-compile: no alc.exe found; set ALC");
}
const ALC = findAlc();
const { generateMutationSet } = await import(`${repo}/packages/runner/src/orchestrator`);

const scratch = mkdtempSync(join(tmpdir(), "r364-"));
const work = join(scratch, "p");
const compiles = (dir: string, set: string[]): boolean => {
  mkdirSync(join(dir, ".alpackages"), { recursive: true });
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
  return r.status === 0 && existsSync(out);
};
const buildWith = (
  project: string,
  file: string,
  from: number,
  to: number,
  text: string,
  set: string[],
) => {
  rmSync(work, { recursive: true, force: true });
  cpSync(project, work, { recursive: true });
  const p = join(work, file);
  const src = readFileSync(p, "utf8");
  writeFileSync(p, `${src.slice(0, from)}${text}${src.slice(to)}`);
  return compiles(work, set);
};

console.log(["repro", "site", "operator", "span", "set", "compiled", "compiledOut"].join("\t"));
for (const project of projects) {
  const name = project
    .replaceAll("\\", "/")
    .split("/")
    .slice(-2)
    .join("/")
    .replace(/^r364\//, "");
  const sets = JSON.parse(readFileSync(join(project, "symbol-sets.json"), "utf8")) as string[][];
  for (const s of sets) {
    rmSync(work, { recursive: true, force: true });
    cpSync(project, work, { recursive: true });
    console.log(
      [
        name,
        "(unmutated)",
        "-",
        "-",
        `[${s.join(",")}]`,
        compiles(work, s) ? "yes" : "no",
        "-",
      ].join("\t"),
    );
  }
  const set = await generateMutationSet(project, {});
  type Spec = {
    operatorName: string;
    before: { startIndex: number; endIndex: number; startPosition: { row: number } };
    after: { text: string };
  };
  for (const f of set.files as { path: string; specs: Spec[] }[])
    for (const sp of f.specs)
      for (const s of sets) {
        const { startIndex: a, endIndex: b } = sp.before;
        const compiled = buildWith(project, f.path, a, b, sp.after.text, s);
        const compiledOut = buildWith(project, f.path, a, b, "R364POISON", s);
        console.log(
          [
            name,
            `${f.path.replaceAll("\\", "/")}:${sp.before.startPosition.row + 1}`,
            sp.operatorName,
            `${a}-${b}`,
            `[${s.join(",")}]`,
            compiled ? "yes" : "no",
            compiledOut ? "yes" : "no",
          ].join("\t"),
        );
      }
}
rmSync(scratch, { recursive: true, force: true });
