import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

// Runs scripts/kraken-setup.sh in a temp worktree with fake git/npm/bun on PATH. Checks the two
// things a re-run must get right: sibling repos are cloned once then pulled, and files that an
// older fixture-symbols.tar carried but the new one does not are removed.
const script = resolve(import.meta.dir, "kraken-setup.sh");

function setup(): { root: string; bin: string; wt: string; src: string; calls: string } {
  const root = mkdtempSync(join(tmpdir(), "kraken-setup-"));
  const bin = join(root, "bin");
  const wt = join(root, "wt");
  const src = join(root, "src");
  const calls = join(root, "calls.log");
  mkdirSync(bin);
  mkdirSync(join(wt, ".kraken-local"), { recursive: true });
  const fake = (name: string, body: string) => writeFileSync(join(bin, name), `#!/bin/bash\necho "${name} $*" >> "${calls.replaceAll("\\", "/")}"\n${body}\n`);
  // clone <url> <dest>: make <dest>/.git so the second run takes the pull branch
  fake("git", 'if [ "$1" = clone ]; then mkdir -p "$4/.git"; fi');
  fake("npm", "true");
  fake("bun", "true");
  return { root, bin, wt, src, calls };
}

function run(t: ReturnType<typeof setup>) {
  const r = Bun.spawnSync(["bash", script], {
    cwd: t.wt,
    env: { ...process.env, PATH: t.bin + delimiter + process.env.PATH, KRAKEN_SETUP_SRC: t.src },
  });
  expect(r.stderr.toString()).toBe("");
  expect(r.exitCode).toBe(0);
}

function makeTar(t: ReturnType<typeof setup>, files: string[]) {
  const stage = join(t.root, "stage");
  rmSync(stage, { recursive: true, force: true });
  for (const f of files) {
    mkdirSync(join(stage, f, ".."), { recursive: true });
    writeFileSync(join(stage, f), "x");
  }
  const tar = join(t.wt, ".kraken-local", "fixture-symbols.tar");
  const r = Bun.spawnSync(["tar", "-cf", "fixture-symbols.tar", ...files], { cwd: stage });
  expect(r.exitCode).toBe(0);
  writeFileSync(tar, readFileSync(join(stage, "fixture-symbols.tar")));
}

test("clones once then pulls, and removes files a newer tar no longer carries", () => {
  const t = setup();
  try {
    makeTar(t, ["fx/a/one.app", "fx/b/two.app"]);
    run(t);
    expect(existsSync(join(t.wt, "fx/a/one.app"))).toBe(true);
    expect(existsSync(join(t.wt, "fx/b/two.app"))).toBe(true);
    expect(readFileSync(t.calls, "utf8").match(/^git clone /gm)?.length).toBe(3);

    makeTar(t, ["fx/a/one.app"]);
    run(t);
    expect(existsSync(join(t.wt, "fx/a/one.app"))).toBe(true);
    expect(existsSync(join(t.wt, "fx/b/two.app"))).toBe(false);
    const log = readFileSync(t.calls, "utf8");
    expect(log.match(/^git clone /gm)?.length).toBe(3);
    expect(log.match(/ pull /g)?.length).toBe(3);
    expect(log.match(/^bun install/gm)?.length).toBe(2);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});
