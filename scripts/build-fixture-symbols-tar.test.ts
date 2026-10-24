// R670: the tar rebuild script's argument refusals. They run before anything is extracted or built,
// so no tar and no alc are needed here. Linux only, like kraken-setup.test.ts: the script runs only
// in the kraken image, and Git Bash's `realpath` spells Windows paths differently (CI run 39882085249).
import { test as bunTest, afterEach, expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
