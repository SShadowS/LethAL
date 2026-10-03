import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
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
  const fake = (name: string, body: string) =>
    writeFileSync(
      join(bin, name),
      `#!/bin/bash\necho "${name} $*" >> "${calls.replaceAll("\\", "/")}"\n${body}\n`,
      { mode: 0o755 },
    );
  // clone <url> <dest>: make <dest>/.git so the second run takes the pull branch
  fake(
    "git",
    'if [ "$1" = clone ]; then mkdir -p "$4/.git"; fi\nif [ "$1" = rev-parse ]; then echo "$FAKE_TOP"; fi',
  );
  // alc /project:<p> /packagecachepath:<p> /out:<file>: writes the out file, as the real one does
  fake("alc", 'for a in "$@"; do case "$a" in /out:*) echo built > "${a#/out:}" ;; esac; done');
  fake("npm", "true");
  fake("bun", "true");
  fake("flock", "true"); // Git Bash has none; the lock itself is not under test
  return { root, bin, wt, src, calls };
}

function run(t: ReturnType<typeof setup>, env: Record<string, string> = {}) {
  const r = Bun.spawnSync(["bash", script], {
    cwd: t.wt,
    env: {
      ...process.env,
      PATH: t.bin + delimiter + process.env.PATH,
      KRAKEN_SETUP_SRC: t.src,
      ...env,
    },
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

test("a manifest entry with .. or an absolute path removes nothing outside the worktree", () => {
  const t = setup();
  try {
    const outside = join(t.root, "outside.txt");
    const abs = join(t.root, "absolute.txt");
    writeFileSync(outside, "keep");
    writeFileSync(abs, "keep");
    makeTar(t, ["fx/a/one.app"]);
    // an older manifest (or a tampered one) names files that are not under the worktree
    writeFileSync(
      join(t.wt, ".kraken-local", "fixture-symbols.manifest"),
      `../outside.txt\n${abs.replaceAll("\\", "/")}\nfx/gone.app\n`,
    );
    mkdirSync(join(t.wt, "fx"), { recursive: true });
    writeFileSync(join(t.wt, "fx/gone.app"), "x");
    run(t);
    expect(existsSync(outside)).toBe(true);
    expect(existsSync(abs)).toBe(true);
    expect(existsSync(join(t.wt, "fx/gone.app"))).toBe(false);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test("the control app is built in the main checkout only, and only when missing or stale", () => {
  const t = setup();
  try {
    const ctl = join(t.wt, "extensions", "lethal-control");
    mkdirSync(join(ctl, "src"), { recursive: true });
    writeFileSync(join(ctl, "app.json"), "{}");
    writeFileSync(join(ctl, "src", "a.al"), "x");
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(ctl, "app.json"), old, old);
    utimesSync(join(ctl, "src", "a.al"), old, old);
    const builds = () => readFileSync(t.calls, "utf8").match(/^alc /gm)?.length ?? 0;
    const main = {
      FAKE_TOP: "/work/x",
      KRAKEN_MAIN_TOP: "/work/x",
      LETHAL_ALC_DIR: t.bin.replaceAll("\\", "/"),
    };

    run(t, { ...main, FAKE_TOP: "/work/other" }); // another worktree: never builds
    expect(builds()).toBe(0);
    expect(existsSync(join(ctl, "lethal-control.app"))).toBe(false);

    run(t, main); // missing: build
    expect(builds()).toBe(1);
    expect(readFileSync(t.calls, "utf8")).toMatch(
      /^alc \/project:\S+\/extensions\/lethal-control \/packagecachepath:\S+\/extensions\/lethal-control\/\.alpackages \/out:\S+\/extensions\/lethal-control\/lethal-control\.app$/m,
    );

    run(t, main); // up to date: skip
    expect(builds()).toBe(1);

    const later = new Date(Date.now() + 60_000);
    utimesSync(join(ctl, "src", "a.al"), later, later); // a source newer than the app: rebuild
    run(t, main);
    expect(builds()).toBe(2);

    utimesSync(
      join(ctl, "app.json"),
      new Date(Date.now() + 120_000),
      new Date(Date.now() + 120_000),
    );
    run(t, main); // app.json newer: rebuild
    expect(builds()).toBe(3);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});
