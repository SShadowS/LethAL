// R670: the tar rebuild script's argument refusals. They run before anything is extracted or built,
// so no tar and no alc are needed here. Linux only, like kraken-setup.test.ts: the script runs only
// in the kraken image, and Git Bash's `realpath` spells Windows paths differently (CI run 39882085249).
import { test as bunTest, afterEach, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const test = process.platform === "win32" ? bunTest.skip : bunTest;
const SCRIPT = join(import.meta.dir, "build-fixture-symbols-tar.sh");
const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", ...env },
  });

let dir = "";
afterEach(() => {
  if (dir !== "") rmSync(dir, { recursive: true, force: true });
  dir = "";
});

test("the script parses", () => {
  expect(spawnSync("bash", ["-n", SCRIPT]).status).toBe(0);
});

test("a wrong argument count is refused with usage", () => {
  const r = run(["a", "b", "c"]);
  expect(r.status).toBe(2);
  expect(r.stderr).toContain("usage:");
});

test("an existing output file is refused and left as it was", () => {
  dir = mkdtempSync(join(tmpdir(), "lethal-r670-"));
  const out = join(dir, "out.tar");
  writeFileSync(out, "keep");
  const r = run([join(dir, "old.tar"), dir, join(dir, "work"), out]);
  expect(r.status).toBe(2);
  expect(r.stderr).toContain(`refused: ${out} exists`);
});

test("the kraken secret_files tar's path is refused as an output, even spelled another way", () => {
  dir = mkdtempSync(join(tmpdir(), "lethal-r670-"));
  const secret = join(dir, "fixture-symbols.tar"); // absent, so only this refusal can fire
  // not join(): it would normalise the `./x/..` away
  const spelled = `${dir}/./x/../fixture-symbols.tar`;
  const r = run([join(dir, "old.tar"), dir, join(dir, "work"), spelled], {
    FIXTURE_SYMBOLS_OLD_TAR: secret,
  });
  expect(r.status).toBe(2);
  expect(r.stderr).toContain("is the kraken secret_files tar");
});

test("the default secret path is the real kraken delivery, refused as such whether it exists or not", () => {
  dir = mkdtempSync(join(tmpdir(), "lethal-r670-"));
  // The secret check runs BEFORE the exists check, so its own text is asserted on any machine.
  const r = run([
    join(dir, "old.tar"),
    dir,
    join(dir, "absent", "work"),
    "/work/lethal/.kraken-local/./fixture-symbols.tar",
  ]);
  expect(r.status).toBe(2);
  expect(r.stderr).toContain(
    "refused: /work/lethal/.kraken-local/fixture-symbols.tar is the kraken secret_files tar",
  );
});

// R1128: a dependency with a symbol-sets.json is built under its first set. A fake alc records its
// arguments and writes its /out file, so the whole script runs on a two-project tar.
function rebuild(symbolSets: string | undefined): string[] {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "lethal-r1128-")));
  const repo = join(dir, "repo");
  const dep = { name: "Dep", publisher: "LethAL", version: "1.0.0.0" };
  mkdirSync(join(repo, "fixtures", "dep"), { recursive: true });
  writeFileSync(join(repo, "fixtures", "dep", "app.json"), JSON.stringify(dep));
  if (symbolSets !== undefined)
    writeFileSync(join(repo, "fixtures", "dep", "symbol-sets.json"), symbolSets);
  // the script also scans examples/*/app.json, which the real repo always has
  mkdirSync(join(repo, "examples", "ex"), { recursive: true });
  writeFileSync(join(repo, "examples", "ex", "app.json"), JSON.stringify({ name: "Ex" }));
  mkdirSync(join(repo, "fixtures", "dep-tests"), { recursive: true });
  writeFileSync(
    join(repo, "fixtures", "dep-tests", "app.json"),
    JSON.stringify({ name: "Dep Tests", dependencies: [dep] }),
  );
  // the old tar: both projects' .alpackages, with a stale LethAL copy the script must replace
  const src = join(dir, "src");
  for (const p of ["dep", "dep-tests"]) {
    mkdirSync(join(src, "fixtures", p, ".alpackages"), { recursive: true });
    writeFileSync(join(src, "fixtures", p, ".alpackages", "Microsoft_System.app"), "sys");
  }
  writeFileSync(join(src, "fixtures", "dep-tests", ".alpackages", "LethAL_Dep_0.9.0.0.app"), "old");
  mkdirSync(join(src, "examples", "ex", ".alpackages"), { recursive: true });
  writeFileSync(join(src, "examples", "ex", ".alpackages", "Microsoft_System.app"), "sys");
  mkdirSync(join(src, "extensions"));
  expect(spawnSync("tar", ["-cf", join(dir, "old.tar"), "-C", src, "fixtures", "examples", "extensions"]).status).toBe(0);
  const alcDir = join(dir, "alc");
  mkdirSync(alcDir);
  const log = join(dir, "alc-args.txt");
  writeFileSync(
    join(alcDir, "alc"),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >> '${log}'\nfor a in "$@"; do case "$a" in /out:*) echo built > "\${a#/out:}";; esac; done\n`,
  );
  chmodSync(join(alcDir, "alc"), 0o755);
  const r = run([join(dir, "old.tar"), repo, join(dir, "work"), join(dir, "out.tar")], {
    LETHAL_ALC_DIR: alcDir,
    FIXTURE_SYMBOLS_OLD_TAR: join(dir, "absent.tar"),
  });
  expect(r.stderr).toBe("");
  expect(r.status).toBe(0);
  return readFileSync(log, "utf8").trim().split("\n");
}

test("a dependency with a symbol-sets.json is built under its first set (sandbox-wrapped: WRAPDEF)", () => {
  const args = rebuild('[["WRAPDEF", "WRAPX"], ["OTHER"]]');
  expect(args).toContain("/define:WRAPDEF,WRAPX");
  expect(args.filter((a) => a.startsWith("/define:"))).toEqual(["/define:WRAPDEF,WRAPX"]);
});

test("a dependency without a symbol-sets.json, or whose first set is empty, gets no /define", () => {
  expect(rebuild(undefined).some((a) => a.startsWith("/define:"))).toBe(false);
  rmSync(dir, { recursive: true, force: true });
  expect(rebuild('[[], ["LETHALA"]]').some((a) => a.startsWith("/define:"))).toBe(false);
});

test("a relative output path is resolved against the caller's directory, not the extracted tree", () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "lethal-r670-")));
  writeFileSync(join(dir, "rel.tar"), "keep");
  const r = spawnSync("bash", [SCRIPT, "old.tar", ".", "work", "rel.tar"], {
    cwd: dir,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });
  expect(r.status).toBe(2);
  expect(r.stderr).toContain(`refused: ${dir}/rel.tar exists`);
});
