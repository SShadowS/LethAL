import { test as bunTest, describe, expect } from "bun:test";
import { createHash } from "node:crypto";
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

// R416: kraken-setup.sh runs only inside the Linux kraken image, so these run on Linux only (the
// unit-linux CI job). On Windows the result depends on which bash the host finds: the WSL launcher
// fails everything, and Git's bash started from PowerShell (as CI does) does not keep the fakes
// first on PATH (measured 2026-10-03).
const test = process.platform === "win32" ? bunTest.skip : bunTest;

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
  // PR-484: `ls-files [-z] [--error-unmatch] <paths>` answers from .git/tracked (one path per line), sorted like git.
  fake(
    "git",
    [
      'if [ "$1" = clone ]; then mkdir -p "$4/.git"; fi',
      'if [ "$1" = rev-parse ]; then echo "$FAKE_TOP"; fi',
      'if [ "$1" = ls-files ]; then',
      "  shift; z=; um=",
      '  [ "$1" = -z ] && { z=1; shift; }',
      '  [ "$1" = --error-unmatch ] && { um=1; shift; }',
      "  for f in $(printf '%s\\n' \"$@\" | sort); do",
      '    if grep -qx "$f" .git/tracked 2>/dev/null; then if [ -n "$z" ]; then printf "%s\\0" "$f"; else echo "$f"; fi',
      '    elif [ -n "$um" ]; then exit 1; fi',
      "  done",
      "fi",
    ].join("\n"),
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

/** The main checkout's env, with an up-to-date control app so its build step does nothing. */
function mainCheckout(t: ReturnType<typeof setup>): Record<string, string> {
  const ctl = join(t.wt, "extensions", "lethal-control");
  mkdirSync(join(ctl, "src"), { recursive: true });
  writeFileSync(join(ctl, "app.json"), "{}");
  writeFileSync(join(ctl, "src", "a.al"), "x");
  const old = new Date(Date.now() - 60_000);
  utimesSync(join(ctl, "app.json"), old, old);
  utimesSync(join(ctl, "src", "a.al"), old, old);
  writeFileSync(join(ctl, "lethal-control.app"), "built\n");
  return { FAKE_TOP: "/work/x", KRAKEN_MAIN_TOP: "/work/x", LETHAL_ALC_DIR: t.bin };
}
const namedCopy = (t: ReturnType<typeof setup>) => {
  const local = join(t.wt, ".kraken-local");
  const tar = readFileSync(join(local, "fixture-symbols.tar"));
  const sha = createHash("sha256").update(tar).digest("hex");
  return { tar, path: join(local, `fixture-symbols-${sha.slice(0, 12)}.tar`) };
};

test("R670: each delivered tar is also kept under its sha-named file, and an older one stays", () => {
  const t = setup();
  try {
    const main = mainCheckout(t);
    makeTar(t, ["fx/a/one.app"]);
    run(t, main);
    const first = namedCopy(t);
    expect(readFileSync(first.path)).toEqual(first.tar);
    run(t, main); // a re-run with the same tar copies nothing and does not fail
    makeTar(t, ["fx/a/one.app", "fx/b/two.app"]);
    run(t, main);
    const second = namedCopy(t);
    expect(second.path).not.toBe(first.path);
    expect(readFileSync(second.path)).toEqual(second.tar);
    expect(readFileSync(first.path)).toEqual(first.tar);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test("R670: another worktree gets no sha-named copy (main checkout only)", () => {
  const t = setup();
  try {
    makeTar(t, ["fx/a/one.app"]);
    run(t, { FAKE_TOP: "/work/other", KRAKEN_MAIN_TOP: "/work/x" });
    expect(existsSync(join(t.wt, "fx/a/one.app"))).toBe(true);
    expect(existsSync(namedCopy(t).path)).toBe(false);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

test("R670: with an R614 marker the two gate folders are neither removed nor written", () => {
  const t = setup();
  try {
    const gate = "fixtures/sandbox-tests/.alpackages";
    const data = "fixtures/sandbox-data-tests/.alpackages";
    makeTar(t, [`${gate}/old.app`, `${data}/old.app`, "fx/a/one.app"]);
    run(t); // no marker yet: extracted as any folder
    expect(existsSync(join(t.wt, gate, "old.app"))).toBe(true);
    writeFileSync(join(t.wt, ".fixture-symbols.sha256"), `${"b".repeat(64)}\n`);
    makeTar(t, [`${gate}/new.app`, `${data}/new.app`, "fx/a/one.app", "fx/b/two.app"]);
    run(t);
    for (const d of [gate, data]) {
      expect(existsSync(join(t.wt, d, "old.app"))).toBe(true); // not removed
      expect(existsSync(join(t.wt, d, "new.app"))).toBe(false); // not written
    }
    expect(existsSync(join(t.wt, "fx/b/two.app"))).toBe(true); // every other folder still extracted
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

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

test("a sibling with no build script does not fail setup (build runs with --if-present)", () => {
  const t = setup();
  try {
    // like real npm for a package without a build script: `run build` fails unless --if-present
    writeFileSync(
      join(t.bin, "npm"),
      `#!/bin/bash\necho "npm $*" >> "${t.calls.replaceAll("\\", "/")}"\nif [ "$1" = run ]; then case " $* " in *" --if-present "*) exit 0 ;; esac; echo 'npm error Missing script: "build"' >&2; exit 1; fi\n`,
      { mode: 0o755 },
    );
    run(t);
    expect(readFileSync(t.calls, "utf8").match(/^npm run .*--if-present build$/gm)?.length).toBe(3);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});

// PR-484 (spec r2): a sibling's dependencies are reinstalled when its TRACKED dependency files (package.json,
// package-lock.json, bun.lock) differ from the stamp in node_modules: `npm ci` for a tracked package-lock.json, else
// `npm install`. Every failure fails setup by name and writes no stamp.
describe("PR-484: reinstall on a dependency change", () => {
  const LOCK = "business-central-mcp"; // tracks package-lock.json
  const BUN = "pi-mcp"; // tracks bun.lock; its package-lock.json is an untracked npm leftover
  const STAMP = ".kraken-deps.sha256";
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  /** A fake npm: logs the call; `ci` recreates node_modules (failing when FAIL_CI=1); `install` creates it. */
  const npmFake = (t: ReturnType<typeof setup>) =>
    writeFileSync(
      join(t.bin, "npm"),
      `#!/bin/bash\necho "npm $* @$(basename "$PWD")" >> "${t.calls.replaceAll("\\", "/")}"\nif [ "$1" = ci ]; then [ "$FAIL_CI" = 1 ] && exit 1; rm -rf node_modules; mkdir node_modules; fi\nif [ "$1" = install ]; then mkdir -p node_modules; fi\n`,
      { mode: 0o755 },
    );
  /** One sibling: its files, which of them git tracks, node_modules (unless `noModules`) and an optional stamp. */
  const repo = (
    t: ReturnType<typeof setup>,
    name: string,
    o: { files?: Record<string, string>; tracked?: string[]; stamp?: string; noModules?: true },
  ) => {
    const dir = join(t.src, name);
    mkdirSync(join(dir, ".git"), { recursive: true });
    for (const [f, text] of Object.entries(o.files ?? {})) writeFileSync(join(dir, f), text);
    writeFileSync(join(dir, ".git", "tracked"), `${(o.tracked ?? []).join("\n")}\n`);
    if (o.noModules === undefined) mkdirSync(join(dir, "node_modules"), { recursive: true });
    if (o.stamp !== undefined) writeFileSync(join(dir, "node_modules", STAMP), `${o.stamp}\n`);
  };
  /** The stamp setup computes: the tracked files' contents, concatenated in git's (sorted) order. */
  const depsSha = (files: Record<string, string>, tracked: string[]) =>
    sha(
      [...tracked]
        .sort()
        .map((f) => files[f] ?? "")
        .join(""),
    );
  const calls = (t: ReturnType<typeof setup>, verb: string) =>
    (existsSync(t.calls) ? readFileSync(t.calls, "utf8") : "")
      .split("\n")
      .filter((l) => l.startsWith(`npm ${verb} `));
  const stampOf = (t: ReturnType<typeof setup>, name: string) =>
    readFileSync(join(t.src, name, "node_modules", STAMP), "utf8").trim();
  const runFail = (t: ReturnType<typeof setup>, env: Record<string, string>) =>
    Bun.spawnSync(["bash", script], {
      cwd: t.wt,
      env: {
        ...process.env,
        PATH: t.bin + delimiter + process.env.PATH,
        KRAKEN_SETUP_SRC: t.src,
        ...env,
      },
    });
  const LOCKED = { "package.json": "pkg-v1", "package-lock.json": "lock-v1" };
  const LOCKED_TRACKED = ["package.json", "package-lock.json"];
  /** bc-dev-mcp and pi-mcp with no tracked dependency file and node_modules present: they install nothing. */
  const quiet = (t: ReturnType<typeof setup>, but: string) => {
    for (const r of ["bc-dev-mcp", LOCK, BUN]) if (r !== but) repo(t, r, {});
  };

  test("(1) tracked lockfile and a MATCHING stamp: nothing installed", () => {
    const t = setup();
    try {
      npmFake(t);
      quiet(t, LOCK);
      repo(t, LOCK, {
        files: LOCKED,
        tracked: LOCKED_TRACKED,
        stamp: depsSha(LOCKED, LOCKED_TRACKED),
      });
      run(t);
      expect(calls(t, "ci")).toEqual([]);
      expect(calls(t, "install")).toEqual([]);
    } finally {
      rmSync(t.root, { recursive: true, force: true });
    }
  });
  test("(2) the tracked lockfile changed: exactly one npm ci, in that repo, and the stamp is the new sha", () => {
    const t = setup();
    try {
      npmFake(t);
      quiet(t, LOCK);
      const now = { ...LOCKED, "package-lock.json": "lock-v2" };
      repo(t, LOCK, {
        files: now,
        tracked: LOCKED_TRACKED,
        stamp: depsSha(LOCKED, LOCKED_TRACKED),
      });
      run(t);
      expect(calls(t, "ci")).toEqual([`npm ci --loglevel=error @${LOCK}`]);
      expect(calls(t, "install")).toEqual([]);
      expect(stampOf(t, LOCK)).toBe(depsSha(now, LOCKED_TRACKED));
    } finally {
      rmSync(t.root, { recursive: true, force: true });
    }
  });
  test("(3) node_modules with no stamp: npm ci once; a second run installs nothing", () => {
    const t = setup();
    try {
      npmFake(t);
      quiet(t, LOCK);
      repo(t, LOCK, { files: LOCKED, tracked: LOCKED_TRACKED });
      run(t);
      expect(calls(t, "ci")).toHaveLength(1);
      run(t);
      expect(calls(t, "ci")).toHaveLength(1);
    } finally {
      rmSync(t.root, { recursive: true, force: true });
    }
  });
  test("(4) a failing npm ci fails setup by name, writes no stamp, and stops before the build and the next repo", () => {
    const t = setup();
    try {
      npmFake(t);
      quiet(t, LOCK);
      const now = { ...LOCKED, "package-lock.json": "lock-v2" };
      repo(t, LOCK, {
        files: now,
        tracked: LOCKED_TRACKED,
        stamp: depsSha(LOCKED, LOCKED_TRACKED),
      });
      const r = runFail(t, { FAIL_CI: "1" });
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr.toString()).toContain("kraken-setup: npm ci failed in");
      expect(stampOf(t, LOCK)).toBe(depsSha(LOCKED, LOCKED_TRACKED));
      const log = readFileSync(t.calls, "utf8");
      expect(log).not.toContain(`build @${LOCK}`);
      expect(log).not.toContain(`@${BUN}`);
    } finally {
      rmSync(t.root, { recursive: true, force: true });
    }
  });
  test("(5) no tracked dependency file: npm install only when node_modules is missing", () => {
    const t = setup();
    try {
      npmFake(t);
      repo(t, "bc-dev-mcp", { noModules: true });
      repo(t, LOCK, { noModules: true });
      repo(t, BUN, {});
      run(t);
      expect(calls(t, "install").sort()).toEqual(
        [
          `npm install --loglevel=error @${LOCK}`,
          "npm install --loglevel=error @bc-dev-mcp",
        ].sort(),
      );
      expect(calls(t, "ci")).toEqual([]);
    } finally {
      rmSync(t.root, { recursive: true, force: true });
    }
  });
  test("(6) bun.lock tracked, package-lock.json UNTRACKED, package.json bumped: npm install (not ci), new stamp", () => {
    const t = setup();
    try {
      npmFake(t);
      quiet(t, BUN);
      const was = { "package.json": "pkg-v1", "bun.lock": "bun-v1", "package-lock.json": "stale" };
      const now = { ...was, "package.json": "pkg-v2", "bun.lock": "bun-v2" };
      const tracked = ["package.json", "bun.lock"];
      repo(t, BUN, { files: now, tracked, stamp: depsSha(was, tracked) });
      run(t);
      expect(calls(t, "ci")).toEqual([]);
      expect(calls(t, "install")).toEqual([`npm install --loglevel=error @${BUN}`]);
      expect(stampOf(t, BUN)).toBe(depsSha(now, tracked));
    } finally {
      rmSync(t.root, { recursive: true, force: true });
    }
  });
  test("(7) a failing hash fails setup by name and installs nothing (never an empty-equals-empty match)", () => {
    const t = setup();
    try {
      npmFake(t);
      writeFileSync(join(t.bin, "sha256sum"), "#!/bin/bash\nexit 1\n", { mode: 0o755 });
      quiet(t, LOCK);
      repo(t, LOCK, { files: LOCKED, tracked: LOCKED_TRACKED });
      const r = runFail(t, {});
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr.toString()).toContain("kraken-setup: hashing the dependency files failed in");
      expect(calls(t, "ci")).toEqual([]);
    } finally {
      rmSync(t.root, { recursive: true, force: true });
    }
  });
});

test("siblings default to /work/src, on the work volume", () => {
  expect(readFileSync(script, "utf8")).toContain('src="${KRAKEN_SETUP_SRC:-/work/src}"');
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
      /^alc \/project:\S+\/extensions\/lethal-control \/packagecachepath:\S+\/extensions\/lethal-control\/\.alpackages \/out:\S+\/extensions\/lethal-control\/lethal-control\.app\.tmp$/m,
    );
    expect(readFileSync(join(ctl, "lethal-control.app"), "utf8")).toBe("built\n");
    expect(existsSync(join(ctl, "lethal-control.app.tmp"))).toBe(false);

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

test("a compile that fails part-way fails setup and leaves no fresh-looking app", () => {
  const t = setup();
  try {
    const ctl = join(t.wt, "extensions", "lethal-control");
    mkdirSync(join(ctl, "src"), { recursive: true });
    writeFileSync(join(ctl, "app.json"), "{}");
    // this alc writes a partial out file, then fails
    writeFileSync(
      join(t.bin, "alc"),
      '#!/bin/bash\nfor a in "$@"; do case "$a" in /out:*) echo partial > "${a#/out:}" ;; esac; done\nexit 1\n',
      { mode: 0o755 },
    );
    const r = Bun.spawnSync(["bash", script], {
      cwd: t.wt,
      env: {
        ...process.env,
        PATH: t.bin + delimiter + process.env.PATH,
        KRAKEN_SETUP_SRC: t.src,
        FAKE_TOP: "/work/x",
        KRAKEN_MAIN_TOP: "/work/x",
        LETHAL_ALC_DIR: t.bin.replaceAll("\\", "/"),
      },
    });
    expect(r.exitCode).not.toBe(0);
    expect(existsSync(join(ctl, "lethal-control.app"))).toBe(false);
  } finally {
    rmSync(t.root, { recursive: true, force: true });
  }
});
