import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type Dump,
  EXTERNAL_SETS,
  type Git,
  HEAVY_GUARD_EXIT,
  RefusedError,
  SLOT_BUSY,
  corpusHeadOf,
  diffDumps,
  dumperKeyOf,
  entryDir,
  exitCodeOf,
  findProjects,
  generationChanged,
  gitIn,
  guardInSlot,
  heavyVerdict,
  isHeavy,
  parseKeyLine,
  parsePs,
  pickMaster,
  readEntry,
  resolveProjects,
  slotHeld,
  slotted,
  trySlots,
  writeEntry,
} from "./corpus-snapshot.ts";

const REPO_ROOT = join(import.meta.dir, "..");
// Not `lethal-*`: the R358 preload check would read a leftover as this file's leak.
const TMP = mkdtempSync(join(tmpdir(), "corpus-snapshot-test-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
let seq = 0;
const fresh = (tag: string): string => {
  const d = join(TMP, `${tag}-${seq++}`);
  mkdirSync(d, { recursive: true });
  return d;
};

function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

/** A temp git repo shaped like a checkout; returns it with a git runner. */
function repo(): { dir: string; git: Git; commit: (files: Record<string, string>) => string } {
  const dir = fresh("repo");
  const git = gitIn(dir);
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "t"]);
  git(["config", "commit.gpgsign", "false"]);
  const commit = (files: Record<string, string>): string => {
    for (const [p, t] of Object.entries(files)) write(dir, p, t);
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "c"]);
    return git(["rev-parse", "HEAD"]);
  };
  commit({
    "packages/engine/src/x.ts": "export const x = 1;\n",
    "docs/a.md": "a\n",
    "fixtures/x/app.json": "{}\n",
    "fixtures/x/a.al": "codeunit 1 A {}\n",
    "scripts/prod-identity-keys.ts": "// dumper v1\n",
    "scripts/corpus-snapshot.ts": "// cli v1\n",
  });
  return { dir, git, commit };
}

/** A stub dumper that records its calls and asserts DONE/manifest are not yet written. */
function stub(): { calls: string[]; dumper: (t: string, out: string, p: string) => void } {
  const calls: string[] = [];
  return {
    calls,
    dumper: (_tree, out, p) => {
      expect(existsSync(join(dirname(out), "DONE")), "DONE before a project").toBe(false);
      expect(existsSync(join(dirname(out), "manifest.json")), "manifest before a project").toBe(
        false,
      );
      calls.push(p);
      writeFileSync(
        out,
        JSON.stringify({ format: 2, specs: 1, hang: 0, skipped: 0, keys: ["f|op|1-2\tT|0|"] }),
      );
    },
  };
}

/** `snapshot` minus the tree and the slot: pick, then dump into the keyed entry dir. */
function snap(
  checkout: string,
  git: Git,
  cache: string,
  sha: string,
  set = "fixtures",
  roots?: Record<string, string>,
): { kind: string; message: string; calls: number } {
  const { key, dumperHash } = dumperKeyOf(checkout);
  const corpusHead = corpusHeadOf(set, sha, git, roots);
  const pick = pickMaster({ cacheRoot: cache, set, sha, key, corpusHead, depDirs: [], git });
  if (pick.kind !== "dump") return { kind: pick.kind, message: pick.message, calls: 0 };
  const s = stub();
  writeEntry({
    dir: entryDir(cache, sha, set, key),
    manifest: {
      format: 2,
      masterSha: sha,
      set,
      dumperKey: key,
      dumperHash,
      bunVersion: Bun.version,
      corpusRoot: join(checkout, "fixtures"),
      corpusHead,
      depDirs: [],
    },
    treeRoot: checkout,
    projects: ["/p/a", "/p/b"],
    dumper: s.dumper,
    print: () => {},
  });
  return { kind: "dump", message: pick.message, calls: s.calls.length };
}

describe("B1 the generation-code rule", () => {
  test("each rule hits, and docs, fixtures, tests and other scripts miss", () => {
    const hits = [
      "packages/engine/src/ast/x.ts",
      "packages/runner/src/orchestrator.ts",
      "packages/engine/native/src/lib.rs",
      "bun.lock",
      "package.json",
      "packages/runner/package.json",
      "bunfig.toml",
      "tsconfig.json",
      "packages/engine/tsconfig.build.json",
      "scripts/prod-identity-keys.ts",
    ];
    const misses = [
      "docs/a.md",
      "fixtures/sandbox-app/src/x.al",
      "packages/runner/tests/x.test.ts",
      "packages/runner/src/x.test.ts",
      "scripts/other.ts",
      "scripts/corpus-snapshot.ts",
      "ROADMAP.md",
    ];
    expect(generationChanged([...hits, ...misses])).toEqual(hits);
  });
});

describe("B2/B3/B3b reuse of an older master entry", () => {
  test("B2 a stale sha is never used when generation code changed", () => {
    const r = repo();
    const cache = fresh("cache");
    const a = r.git(["rev-parse", "HEAD"]);
    expect(snap(r.dir, r.git, cache, a).kind).toBe("dump");
    const b = r.commit({ "packages/engine/src/x.ts": "export const x = 2;\n" });
    const got = snap(r.dir, r.git, cache, b);
    expect(got.kind).toBe("dump");
    expect(got.message).toContain("packages/engine/src/x.ts");
  });
  test("B3 a reusable sha IS reused when generation code did not change", () => {
    const r = repo();
    const cache = fresh("cache");
    const a = r.git(["rev-parse", "HEAD"]);
    snap(r.dir, r.git, cache, a);
    const b = r.commit({ "docs/a.md": "b\n" });
    const got = snap(r.dir, r.git, cache, b);
    expect(got.kind).toBe("reuse");
    expect(got.message).toBe(
      `reuse ${a} for ${b}: 1 commits, 1 files changed, none is generation code`,
    );
    expect(existsSync(join(cache, b))).toBe(false);
    // The same entry is now `cached` for a, and writing nothing for b stays true on a re-run.
    expect(snap(r.dir, r.git, cache, a).kind).toBe("cached");
  });
  test("B3 no reuse from a non-ancestor, nor across a different corpus head", () => {
    const r = repo();
    const cache = fresh("cache");
    const a = r.git(["rev-parse", "HEAD"]);
    r.git(["checkout", "-q", "--orphan", "other"]);
    const c = r.commit({ "docs/a.md": "orphan\n" });
    snap(r.dir, r.git, cache, c);
    r.git(["checkout", "-q", "main"]);
    const b = r.commit({ "docs/a.md": "b\n" });
    expect(snap(r.dir, r.git, cache, b).kind).toBe("dump");
    expect(a).not.toBe(c);
  });
  test("B3b a change under fixtures/ forces a fixtures dump; an external set is still reused", () => {
    const r = repo();
    const cache = fresh("cache");
    const ext = repo();
    const roots = { dc: ext.dir };
    const a = r.git(["rev-parse", "HEAD"]);
    snap(r.dir, r.git, cache, a, "fixtures");
    snap(r.dir, r.git, cache, a, "dc", roots);
    const b = r.commit({ "fixtures/x/a.al": "codeunit 1 A { }\n" });
    const fx = snap(r.dir, r.git, cache, b, "fixtures");
    expect(fx.kind).toBe("dump");
    expect(fx.message).toContain("corpus head changed");
    expect(snap(r.dir, r.git, cache, b, "dc", roots).kind).toBe("reuse");
    // And the external set's own head moving forces a dump for it.
    ext.commit({ "x.al": "y\n" });
    const c = r.commit({ "docs/a.md": "c\n" });
    expect(snap(r.dir, r.git, cache, c, "dc", roots).kind).toBe("dump");
  });
});

describe("B4 a cache entry is never overwritten", () => {
  function entry(cache: string, done: boolean): { dir: string; before: string[] } {
    const dir = entryDir(cache, "b".repeat(40), "fixtures", "k".repeat(16));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "1.jsonl"), '{"keys":["known"]}');
    if (done) writeFileSync(join(dir, "DONE"), "then\n");
    return { dir, before: [readFileSync(join(dir, "1.jsonl"), "utf8"), done ? "then\n" : ""] };
  }
  for (const done of [true, false]) {
    test(`an existing entry (DONE: ${done ? "yes" : "no"}) is refused, untouched, the dumper never called`, () => {
      const cache = fresh("cache");
      const { dir, before } = entry(cache, done);
      const s = stub();
      let err: unknown;
      try {
        writeEntry({
          dir,
          manifest: {} as never,
          treeRoot: "/t",
          projects: ["/p/a", "/p/b"],
          dumper: s.dumper,
          print: () => {},
        });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(RefusedError);
      expect(String(err)).toContain(`DONE: ${done ? "yes" : "no"}`);
      expect(s.calls).toEqual([]);
      expect(readFileSync(join(dir, "1.jsonl"), "utf8")).toBe(before[0] ?? "");
      expect(existsSync(join(dir, "DONE")) ? readFileSync(join(dir, "DONE"), "utf8") : "").toBe(
        before[1] ?? "",
      );
    });
  }
  test("an empty cache: the dumper runs once per project, and DONE is written last", () => {
    const cache = fresh("cache");
    const dir = entryDir(cache, "b".repeat(40), "fixtures", "k".repeat(16));
    const s = stub();
    writeEntry({
      dir,
      manifest: { set: "fixtures" } as never,
      treeRoot: "/t",
      projects: ["/p/a", "/p/b"],
      dumper: s.dumper,
      print: () => {},
    });
    expect(s.calls).toEqual(["/p/a", "/p/b"]);
    expect(existsSync(join(dir, "DONE"))).toBe(true);
    expect(readFileSync(join(dir, "projects.tsv"), "utf8")).toBe("0\t/p/a\n1\t/p/b\n");
  });
  test("an error project stops the dump with no DONE", () => {
    const cache = fresh("cache");
    const dir = entryDir(cache, "b".repeat(40), "fixtures", "k".repeat(16));
    let calls = 0;
    expect(() =>
      writeEntry({
        dir,
        manifest: {} as never,
        treeRoot: "/t",
        projects: ["/p/a", "/p/b"],
        dumper: (_t, out) => {
          calls++;
          writeFileSync(out, JSON.stringify({ error: "Cannot find package '@lethal/engine'" }));
        },
        print: () => {},
      }),
    ).toThrow("@lethal/engine");
    expect(calls).toBe(1);
    expect(existsSync(join(dir, "DONE"))).toBe(false);
  });
  test("a legacy entry (top-level DONE) at the same sha is left byte-identical beside a new one", () => {
    const r = repo();
    const cache = fresh("cache");
    const a = r.git(["rev-parse", "HEAD"]);
    write(cache, `${a}/DONE`, "legacy\n");
    write(cache, `${a}/fixtures/0.jsonl`, '{"keys":["legacy"]}');
    expect(snap(r.dir, r.git, cache, a).kind).toBe("dump");
    expect(readFileSync(join(cache, a, "fixtures", "0.jsonl"), "utf8")).toBe('{"keys":["legacy"]}');
    expect(readFileSync(join(cache, a, "DONE"), "utf8")).toBe("legacy\n");
  });
});

describe("B8 only the dumper keys an entry", () => {
  test("same key -> cached; a changed dumper -> a NEW entry beside; a changed CLI alone -> cached", () => {
    const r = repo();
    const cache = fresh("cache");
    const a = r.git(["rev-parse", "HEAD"]);
    const k1 = dumperKeyOf(r.dir).key;
    expect(snap(r.dir, r.git, cache, a).calls).toBe(2);
    expect(snap(r.dir, r.git, cache, a).kind).toBe("cached");
    const old = readFileSync(join(entryDir(cache, a, "fixtures", k1), "0.jsonl"), "utf8");

    write(r.dir, "scripts/prod-identity-keys.ts", "// dumper v2\n");
    const k2 = dumperKeyOf(r.dir).key;
    expect(k2).not.toBe(k1);
    const second = snap(r.dir, r.git, cache, a);
    expect(second.kind).toBe("dump");
    expect(second.calls).toBe(2);
    expect(existsSync(join(entryDir(cache, a, "fixtures", k2), "DONE"))).toBe(true);
    expect(readFileSync(join(entryDir(cache, a, "fixtures", k1), "0.jsonl"), "utf8")).toBe(old);

    write(r.dir, "scripts/corpus-snapshot.ts", "// cli v2\n");
    expect(dumperKeyOf(r.dir).key).toBe(k2);
    expect(snap(r.dir, r.git, cache, a).kind).toBe("cached");
  });
});

describe("review r1: the cached path and the DONE gate", () => {
  test("#2 a same-sha entry is refused when its corpus head or DEP_DIRS differ from today's", () => {
    const r = repo();
    const cache = fresh("cache");
    const a = r.git(["rev-parse", "HEAD"]);
    snap(r.dir, r.git, cache, a);
    const { key } = dumperKeyOf(r.dir);
    const head = corpusHeadOf("fixtures", a, r.git);
    const base = { cacheRoot: cache, set: "fixtures", sha: a, key, git: r.git };
    expect(pickMaster({ ...base, corpusHead: head, depDirs: [] }).kind).toBe("cached");
    expect(() => pickMaster({ ...base, corpusHead: "f".repeat(40), depDirs: [] })).toThrow(
      "corpus head",
    );
    expect(() => pickMaster({ ...base, corpusHead: head, depDirs: ["/deps"] })).toThrow("DEP_DIRS");
  });
  test("review r2: DEP_DIRS in another ORDER still match", () => {
    const r = repo();
    const cache = fresh("cache");
    const a = r.git(["rev-parse", "HEAD"]);
    snap(r.dir, r.git, cache, a);
    const { key } = dumperKeyOf(r.dir);
    const manifest = join(entryDir(cache, a, "fixtures", key), "manifest.json");
    const m = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, unknown>;
    writeFileSync(manifest, JSON.stringify({ ...m, depDirs: ["/b", "/a"] }));
    const head = corpusHeadOf("fixtures", a, r.git);
    const base = { cacheRoot: cache, set: "fixtures", sha: a, key, git: r.git, corpusHead: head };
    expect(pickMaster({ ...base, depDirs: ["/a", "/b"] }).kind).toBe("cached");
    expect(() => pickMaster({ ...base, depDirs: ["/a"] })).toThrow("DEP_DIRS");
  });
  test("a half-written entry (no DONE) is never used: not as cached, not as a reuse candidate", () => {
    const r = repo();
    const cache = fresh("cache");
    const a = r.git(["rev-parse", "HEAD"]);
    snap(r.dir, r.git, cache, a);
    const { key } = dumperKeyOf(r.dir);
    rmSync(join(entryDir(cache, a, "fixtures", key), "DONE"));
    const head = corpusHeadOf("fixtures", a, r.git);
    const base = { cacheRoot: cache, set: "fixtures", key, depDirs: [], git: r.git };
    expect(pickMaster({ ...base, sha: a, corpusHead: head }).kind).toBe("dump");
    const b = r.commit({ "docs/a.md": "b\n" });
    expect(
      pickMaster({ ...base, sha: b, corpusHead: corpusHeadOf("fixtures", b, r.git) }).kind,
    ).toBe("dump");
  });
});

describe("review r1: --projects and bad flags", () => {
  const index = new Map([
    ["0", "sandbox-app"],
    ["1", "sandbox-data"],
  ]);
  const masterRels = new Set(["sandbox-app", "sandbox-data"]);
  const branchRels = new Set(["sandbox-app", "sandbox-data", "sandbox-new"]);
  test("#3 known names (index, master path, branch-only path) resolve", () => {
    expect([
      ...resolveProjects("0,sandbox-data,sandbox-new/", index, masterRels, branchRels),
    ]).toEqual(["sandbox-app", "sandbox-data", "sandbox-new"]);
  });
  test("#3 an unknown name is refused by name, not dropped", () => {
    expect(() =>
      resolveProjects("sandbox-data,sandbox-dta", index, masterRels, branchRels),
    ).toThrow("sandbox-dta");
    expect(() => resolveProjects("7", index, masterRels, branchRels)).toThrow(RefusedError);
  });
  test("#7 a bad flag exits 2 (refused), not 1", () => {
    const r = Bun.spawnSync(
      [
        process.execPath,
        join(REPO_ROOT, "scripts", "corpus-snapshot.ts"),
        "snapshot",
        "fixtures",
        "--bogus",
      ],
      { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
    );
    expect(r.exitCode, r.stderr.toString()).toBe(2);
    expect(r.stderr.toString()).toContain("--bogus");
  });
});

describe("R724 exit codes of a refusal", () => {
  test("the heavy-job guard refusal exits 75 (try later)", () => {
    expect(exitCodeOf(new RefusedError("heavy-job guard: all three heavy slots held", true))).toBe(
      75,
    );
  });
  test("a missing master entry exits 2 (never retry)", () => {
    expect(exitCodeOf(new RefusedError("no master entry for abc with dumper k. Run first."))).toBe(
      2,
    );
  });
  test("another permanent refusal exits 2, and a non-refusal exits 1", () => {
    expect(exitCodeOf(new RefusedError("zero keys on both sides"))).toBe(2);
    expect(exitCodeOf(new Error("dump failed"))).toBe(1);
  });
  test("flock's busy code is private: it is not the guard's 75, nor 0, 1 or 2", () => {
    expect(SLOT_BUSY).not.toBe(HEAVY_GUARD_EXIT);
    expect([0, 1, 2]).not.toContain(SLOT_BUSY);
  });
});

describe("B5 the heavy-job guard", () => {
  const ps = (rows: string[]): string => ["PID PPID PGID COMMAND", ...rows].join("\n");
  const SELF = 100;
  const base = [
    "1 0 1 init",
    "90 1 90 timeout 3600 bun scripts/corpus-snapshot.ts diff dc --branch /w/src/DC --x /work/src/DC/a",
    `${SELF} 90 90 bun scripts/corpus-snapshot.ts diff dc --in-slot 1`,
    `101 ${SELF} 90 bun scripts/prod-identity-keys.ts /w /tmp/0.jsonl /work/src/DC/app`,
  ];
  const job = (pid: number, pgid: number, root = "/work/src/BC.History/x"): string =>
    `${pid} 1 ${pgid} bun census.ts ${root}`;
  test("0, 1, 2 or 3 foreign process groups -> go, go, go, refuse; self, ancestors and children not counted", () => {
    expect(heavyVerdict(parsePs(ps(base)), SELF, [], 0).refuse).toBe(false);
    expect(heavyVerdict(parsePs(ps([...base, job(200, 200)])), SELF, [], 0).refuse).toBe(false);
    const two = heavyVerdict(parsePs(ps([...base, job(200, 200), job(300, 300)])), SELF, [], 0);
    expect(two.refuse).toBe(false);
    expect(two.foreign.map((p) => p.pid)).toEqual([200, 300]);
    const three = heavyVerdict(
      parsePs(ps([...base, job(200, 200), job(300, 300), job(400, 400)])),
      SELF,
      [],
      0,
    );
    expect(three.refuse).toBe(true);
    expect(three.foreign.map((p) => p.pid)).toEqual([200, 300, 400]);
  });
  test("a timeout+bun pair is ONE job (one pgid)", () => {
    const pair = [
      "200 1 200 timeout 2400 bun x.ts /work/src/DO/a",
      "201 200 200 bun x.ts /work/src/DO/a",
    ];
    const v = heavyVerdict(parsePs(ps([...base, ...pair])), SELF, [], 0);
    expect(v.foreign.length).toBe(1);
    expect(v.refuse).toBe(false);
  });
  test("an ancestor wrapper naming a corpus root is not counted", () => {
    const v = heavyVerdict(parsePs(ps(base)), SELF, [], 0);
    expect(v.foreign).toEqual([]);
  });
  test("another slot counts as a job, and its holder's children are not counted twice", () => {
    const slot = [
      "500 1 500 bun scripts/corpus-snapshot.ts snapshot bch --in-slot 2",
      job(501, 500),
    ];
    slot[1] = "501 500 500 bun prod-identity-keys.ts /t /o /work/src/BC.History/x";
    expect(heavyVerdict(parsePs(ps([...base, ...slot])), SELF, [500], 1).refuse).toBe(false);
    expect(
      heavyVerdict(parsePs(ps([...base, ...slot, job(600, 600)])), SELF, [500], 1).refuse,
    ).toBe(false);
    expect(
      heavyVerdict(parsePs(ps([...base, ...slot, job(600, 600), job(700, 700)])), SELF, [500], 1)
        .refuse,
    ).toBe(true);
  });
  test("/work/src/DOX is not the DO corpus", () => {
    const v = heavyVerdict(parsePs(ps([...base, job(200, 200, "/work/src/DOX/a")])), SELF, [], 0);
    expect(v.foreign).toEqual([]);
  });
  // R626: a parallel itest's workers spawn al-runner children, each in its own process group.
  const itest = (root: number, kids: number): string[] => [
    `${root} 1 ${root} bun run itest:alrunner -- --parallel=3`,
    ...[1, 2, 3].flatMap((i) => {
      const w = root + i * 10;
      return [
        `${w} ${root} ${root} bun al-runner.itest.ts --worker ${i}`,
        `${w + 1} ${w} ${w + 1} /work/tools/al-runner/current/al-runner --output-json ${kids}`,
      ];
    }),
  ];
  test("R626: a parallel itest root with three workers and three al-runner children is ONE job", () => {
    const v = heavyVerdict(parsePs(ps([...base, ...itest(700, 1)])), SELF, [], 0);
    expect(v.foreign.map((p) => p.pid)).toEqual([700]);
  });
  test("R626: a standalone al-runner with no itest ancestor is ONE job", () => {
    const v = heavyVerdict(
      parsePs(ps([...base, "800 1 800 /work/tools/al-runner/current/al-runner --server"])),
      SELF,
      [],
      0,
    );
    expect(v.foreign.map((p) => p.pid)).toEqual([800]);
  });
  test("R626: two separate itest roots are TWO jobs", () => {
    const v = heavyVerdict(parsePs(ps([...base, ...itest(700, 1), ...itest(900, 2)])), SELF, [], 1);
    expect(v.foreign.map((p) => p.pid)).toEqual([700, 900]);
    expect(v.refuse).toBe(true);
  });
  test("R626: a corpus job whose argv merely contains itest:alrunner is NOT an itest root", () => {
    const rows = [
      "950 1 950 bun census.ts /work/src/BC.History/x --note itest:alrunner",
      "951 950 951 bun census.ts /work/src/BC.History/y",
      "952 950 952 bun census.ts /work/src/BC.History/z",
    ];
    const v = heavyVerdict(parsePs(ps([...base, ...rows])), SELF, [], 0);
    expect(v.foreign.map((p) => p.pid)).toEqual([950, 951, 952]);
  });
  test("R626: an itest plus an unrelated corpus job, or a lone al-runner, is TWO jobs -> refuse beside a held slot", () => {
    const withCorpus = heavyVerdict(
      parsePs(ps([...base, ...itest(700, 1), job(600, 600)])),
      SELF,
      [],
      1,
    );
    expect(withCorpus.foreign.length).toBe(2);
    expect(withCorpus.refuse).toBe(true);
    const lone = "800 1 800 /work/tools/al-runner/current/al-runner --server";
    const withRunner = heavyVerdict(parsePs(ps([...base, ...itest(700, 1), lone])), SELF, [], 1);
    expect(withRunner.foreign.length).toBe(2);
    expect(withRunner.refuse).toBe(true);
  });
  test("local runners are heavy by executable or script, never by an argument naming them", () => {
    expect(isHeavy("/work/tools/al-runner/current/al-runner --output-json --test X /tmp/a")).toBe(
      true,
    );
    expect(isHeavy("al-runner --server")).toBe(true);
    expect(
      isHeavy("/opt/dotnet/dotnet exec /home/x/ncl-shadow/abc/al-runner.dll --output-json"),
    ).toBe(true);
    expect(isHeavy("bun run itest:alrunner -- --reports /coord/x")).toBe(true);
    expect(isHeavy("bun packages/runner/itest/al-runner.itest.ts --reports /coord/x")).toBe(true);
    // Not heavy: a unit test FILE named after al-runner, a log watcher, a remote BC gate, a worker.
    expect(isHeavy("bun test packages/runner/tests/al-runner-v3-backend.test.ts")).toBe(false);
    expect(isHeavy("tail -F /coord/handoff/x/al-runner.log")).toBe(false);
    expect(isHeavy("bun packages/runner/itest/hang.itest.ts")).toBe(false);
    expect(isHeavy("bun packages/runner/itest/al-runner.itest.ts --worker 2")).toBe(false);
  });
  test("#1 an EMPTY or 0 slot pid (a manual flock holder) does not hide the container", () => {
    // Lane A holds slot 2 by hand (no pid written); lane B runs an unslotted corpus job.
    const procs = parsePs(ps([...base, job(200, 200)]));
    for (const pid of [0, Number(""), Number.NaN]) {
      const v = heavyVerdict(procs, SELF, [pid], 2);
      expect(
        v.foreign.map((p) => p.pid),
        `slot pid ${pid}`,
      ).toEqual([200]);
      expect(v.refuse, `slot pid ${pid}`).toBe(true);
    }
  });
  test("#1 a STALE slot pid (reused by another job) excludes nothing, so that job is not hidden", () => {
    // pid 200 is now an unrelated corpus job; the slot holder that wrote it is gone.
    const procs = parsePs(ps([...base, job(200, 200), job(201, 201)]));
    const v = heavyVerdict(procs, SELF, [200], 1);
    expect(v.foreign.map((p) => p.pid)).toEqual([200, 201]);
    expect(v.refuse).toBe(true);
    // A LIVE corpus-snapshot holder's children are still excluded, so they are not counted twice.
    const slot = [
      "500 1 500 bun scripts/corpus-snapshot.ts snapshot bch --master --in-slot 2",
      "501 500 500 bun scripts/prod-identity-keys.ts /t /o /work/src/BC.History/x",
    ];
    expect(heavyVerdict(parsePs(ps([...base, ...slot])), SELF, [500], 1).foreign).toEqual([]);
  });
  test("#5 a reader or search naming a corpus root is not a job", () => {
    for (const a of [
      "grep -rn x /work/src/BC.History",
      "git -C /work/src/DC log",
      "less /work/src/DO/a.al",
    ]) {
      expect(isHeavy(a), a).toBe(false);
    }
    expect(isHeavy("bun census.ts /work/src/DC/app")).toBe(true);
  });
  test("review r2: a shell-wrapped census whose child names no corpus is ONE job, not zero", () => {
    // `bash -c 'cd /work/src/BC.History && bun census.ts .'`: only the shell names the corpus.
    const census = [
      "600 1 600 bash -c cd /work/src/BC.History && bun census.ts .",
      "601 600 600 bun census.ts .",
    ];
    const v = heavyVerdict(parsePs(ps([...base, ...census])), SELF, [], 2);
    expect(v.foreign.map((p) => p.pid)).toEqual([600]);
    expect(v.refuse).toBe(true);
  });
  test("an itest:alrunner run (root + al-runner child, one pgid) is ONE job; its workers add none", () => {
    const run = [
      "700 1 700 bun run itest:alrunner",
      "701 700 700 bun packages/runner/itest/al-runner.itest.ts",
      "702 701 700 /work/tools/al-runner/current/al-runner --output-json --test X",
      "703 701 703 bun packages/runner/itest/al-runner.itest.ts --worker 1",
    ];
    const one = heavyVerdict(parsePs(ps([...base, ...run])), SELF, [], 0);
    expect(one.foreign.map((p) => p.pgid)).toEqual([700]);
    expect(one.refuse).toBe(false);
    // With two corpus jobs beside it, that is three others: refuse.
    expect(heavyVerdict(parsePs(ps([...base, ...run, job(800, 800)])), SELF, [], 0).refuse).toBe(
      false,
    );
    expect(
      heavyVerdict(parsePs(ps([...base, ...run, job(800, 800), job(810, 810)])), SELF, [], 0)
        .refuse,
    ).toBe(true);
    // A unit test run named after al-runner beside a corpus job is not a second job.
    const unit = "900 1 900 bun test packages/runner/tests/al-runner-v3-backend.test.ts";
    expect(heavyVerdict(parsePs(ps([...base, unit, job(800, 800)])), SELF, [], 0).refuse).toBe(
      false,
    );
  });

  // R642: three heavy jobs container-wide, of which at most two BaseApp (BC.History) corpus jobs.
  const dc = (pid: number): string => job(pid, pid, "/work/src/DC/x");
  const bch = (pid: number): string => job(pid, pid);
  const TOTAL_CAP = "-> REFUSED (at most three heavy jobs container-wide)";
  const BASEAPP_CAP = "-> REFUSED (at most two BaseApp corpus jobs)";
  test("R642: a 3rd NON-BaseApp heavy job is admitted with 2 others running", () => {
    for (const others of [
      [dc(200), dc(300)],
      [bch(200), bch(300)],
    ]) {
      const v = heavyVerdict(parsePs(ps([...base, ...others])), SELF, [], 0, false);
      expect(v.foreign.length).toBe(2);
      expect(v.refuse, others.join(" | ")).toBe(false);
      expect(v.message).not.toContain("REFUSED");
    }
  });
  test("R642: a 3rd BaseApp job is refused with 2 other BaseApp jobs running, naming the BaseApp cap", () => {
    const v = heavyVerdict(parsePs(ps([...base, bch(200), bch(300)])), SELF, [], 0, true);
    expect(v.refuse).toBe(true);
    expect(v.message).toContain(BASEAPP_CAP);
    expect(v.message).not.toContain(TOTAL_CAP);
    // A held slot whose live holder dumps bch is a BaseApp job too; one that dumps dc is not.
    const holder = (set: string): string[] => [
      `500 1 500 bun scripts/corpus-snapshot.ts snapshot ${set} --master --in-slot 2`,
      `501 500 500 bun scripts/prod-identity-keys.ts /t /o ${EXTERNAL_SETS[set] ?? ""}/x`,
    ];
    const bySlot = heavyVerdict(
      parsePs(ps([...base, ...holder("bch"), bch(300)])),
      SELF,
      [500],
      1,
      true,
    );
    expect(bySlot.refuse).toBe(true);
    expect(bySlot.message).toContain(BASEAPP_CAP);
    expect(
      heavyVerdict(parsePs(ps([...base, ...holder("dc"), bch(300)])), SELF, [500], 1, true).refuse,
    ).toBe(false);
  });
  test("R642 review B1: two held bch slots refuse a 3rd bch job, flags before or after the set", () => {
    // The CLI accepts flags first, and the in-slot re-exec keeps the user's order. The holders'
    // children name BC.History but are skipped as the holders' descendants.
    const holders = (flagsFirst: boolean, set = "bch"): string[] =>
      [500, 600].flatMap((pid, i) => [
        flagsFirst
          ? `${pid} 1 ${pid} bun scripts/corpus-snapshot.ts diff --branch /w/x ${set} --in-slot ${i + 1}`
          : `${pid} 1 ${pid} bun scripts/corpus-snapshot.ts diff ${set} --branch /w/x --in-slot ${i + 1}`,
        `${pid + 1} ${pid} ${pid} bun scripts/prod-identity-keys.ts /t /o ${EXTERNAL_SETS[set] ?? ""}/x`,
      ]);
    for (const flagsFirst of [true, false]) {
      const v = heavyVerdict(
        parsePs(ps([...base, ...holders(flagsFirst)])),
        SELF,
        [500, 600],
        2,
        true,
      );
      expect(v.foreign, `flags first ${flagsFirst}`).toEqual([]);
      expect(v.refuse, `flags first ${flagsFirst}`).toBe(true);
      expect(v.message).toContain(BASEAPP_CAP);
      // Two held dc slots leave room for a 3rd job that is BaseApp.
      expect(
        heavyVerdict(
          parsePs(ps([...base, ...holders(flagsFirst, "dc")])),
          SELF,
          [500, 600],
          2,
          true,
        ).refuse,
        `dc, flags first ${flagsFirst}`,
      ).toBe(false);
    }
  });
  test("R642: a 3rd job that is BaseApp, with 1 BaseApp and 1 non-BaseApp running, is admitted", () => {
    const v = heavyVerdict(parsePs(ps([...base, bch(200), dc(300)])), SELF, [], 0, true);
    expect(v.foreign.length).toBe(2);
    expect(v.refuse).toBe(false);
    expect(v.message).not.toContain("REFUSED");
  });
  test("R642: a 4th heavy job of any kind is refused with 3 others, naming the total cap", () => {
    for (const selfBaseApp of [false, true]) {
      const v = heavyVerdict(
        parsePs(ps([...base, dc(200), dc(300), dc(400)])),
        SELF,
        [],
        0,
        selfBaseApp,
      );
      expect(v.refuse, `self BaseApp ${selfBaseApp}`).toBe(true);
      expect(v.message).toContain(TOTAL_CAP);
      expect(v.message).not.toContain(BASEAPP_CAP);
    }
    // Held slots count toward the total: two held plus one unslotted job.
    const v = heavyVerdict(parsePs(ps([...base, dc(200)])), SELF, [], 2, false);
    expect(v.refuse).toBe(true);
    expect(v.message).toContain(TOTAL_CAP);
  });

  // Real flock on temp lock files (util-linux; the tool runs in the Linux container only, so these
  // two are skipped on the Windows CI job).
  // The holder BLOCKS on the lock: our slotHeld probe takes it for an instant, and a `-n` holder
  // racing that probe would give up.
  async function hold(lock: string, orphan?: string): Promise<{ pid: number }> {
    const script =
      orphan === undefined
        ? `exec 9>"${lock}" && flock 9 && exec sleep 30`
        : `exec 9>"${lock}" && flock 9 && { sleep 30 & echo $! > "${orphan}"; } && exec sleep 30`;
    const p = Bun.spawn(["bash", "-c", script], { stdout: "ignore", stderr: "ignore" });
    for (let i = 0; i < 100; i++) {
      if (slotHeld(dirname(lock), Number(lock.slice(-1)))) return { pid: p.pid };
      await Bun.sleep(20);
    }
    throw new Error(`could not hold ${lock}`);
  }
  const kill = (pid: number): void => {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  };
  const posix = test.skipIf(process.platform === "win32");
  posix("slots are tried 1, 2, 3; all three held by live holders -> null (busy)", async () => {
    const dir = fresh("locks");
    const held: number[] = [];
    try {
      expect(trySlots(dir, () => ["true"])).toEqual({ slot: 1, code: 0 });
      held.push((await hold(join(dir, "heavy.1"))).pid);
      expect(trySlots(dir, () => ["true"])).toEqual({ slot: 2, code: 0 });
      held.push((await hold(join(dir, "heavy.2"))).pid);
      expect(trySlots(dir, () => ["true"])).toEqual({ slot: 3, code: 0 });
      held.push((await hold(join(dir, "heavy.3"))).pid);
      expect(trySlots(dir, () => ["true"])).toBeNull();
    } finally {
      for (const pid of held) kill(pid);
    }
  });
  posix("R724: a child that exits 75 is a result in slot 1, never a busy slot", () => {
    const dir = fresh("locks");
    expect(trySlots(dir, () => ["sh", "-c", "exit 75"])).toEqual({ slot: 1, code: 75 });
  });
  // R724 both throw sites, called in-process: a spawned `snapshot cdo --master` reads the real
  // do-lethal corpus (`git rev-parse HEAD`) and the cache BEFORE it reaches the guard, so a spawn
  // cannot be kept off a real corpus. These two take only a temp lock dir.
  const withLockDir = async (dir: string, f: () => Promise<void> | void): Promise<void> => {
    const old = process.env.LETHAL_HEAVY_LOCK_DIR;
    process.env.LETHAL_HEAVY_LOCK_DIR = dir;
    try {
      await f();
    } finally {
      if (old === undefined) Reflect.deleteProperty(process.env, "LETHAL_HEAVY_LOCK_DIR");
      else process.env.LETHAL_HEAVY_LOCK_DIR = old;
    }
  };
  const refusal = (f: () => unknown): RefusedError => {
    try {
      f();
    } catch (e) {
      if (e instanceof RefusedError) return e;
      throw e;
    }
    throw new Error("expected a RefusedError");
  };
  posix("R724 (a): all three slots held -> the refusal exits 75", async () => {
    const dir = fresh("locks");
    const held: number[] = [];
    try {
      for (const n of [1, 2, 3]) held.push((await hold(join(dir, `heavy.${n}`))).pid);
      await withLockDir(dir, () => {
        const e = refusal(() =>
          slotted("cdo", ["snapshot", "cdo", "--master"], undefined, () => {}),
        );
        expect(e.message).toContain("all three heavy slots held");
        expect(exitCodeOf(e)).toBe(75);
      });
    } finally {
      for (const pid of held) kill(pid);
    }
  });
  posix(
    "R724 (b): the in-slot ps scan refuses -> exits 75 with the guard's own message",
    async () => {
      const dir = fresh("locks");
      const held: number[] = [];
      // Fixed ps rows (the seam): one corpus job that is not ours. No live process is read.
      const rows = [
        "PID PPID PGID COMMAND",
        "500 1 500 bun scripts/prod-identity-keys.ts x /work/src/DC/Cloud",
      ].join("\n");
      try {
        for (const n of [2, 3]) {
          const h = await hold(join(dir, `heavy.${n}`));
          held.push(h.pid);
          writeFileSync(join(dir, `heavy.${n}`), `${h.pid}\n`);
        }
        await withLockDir(dir, () => {
          const e = refusal(() =>
            guardInSlot(
              1,
              false,
              () => {},
              () => rows,
            ),
          );
          expect(e.message).toContain("-> REFUSED");
          expect(exitCodeOf(e)).toBe(75);
        });
      } finally {
        for (const pid of held) kill(pid);
      }
    },
  );
  posix(
    "a holder that was SIGKILLed frees its slot at once; an orphaned child keeps it held",
    async () => {
      const dir = fresh("locks");
      const lock = join(dir, "heavy.1");
      const a = await hold(lock);
      kill(a.pid);
      let free = false;
      for (let i = 0; i < 50 && !free; i++) {
        free = !slotHeld(dir, 1);
        if (!free) await Bun.sleep(20);
      }
      expect(free).toBe(true);

      const pidFile = join(dir, "orphan.pid");
      const b = await hold(lock, pidFile);
      for (let i = 0; i < 50 && !existsSync(pidFile); i++) await Bun.sleep(20);
      const orphan = Number(readFileSync(pidFile, "utf8").trim());
      try {
        kill(b.pid);
        await Bun.sleep(100);
        expect(slotHeld(dir, 1)).toBe(true);
      } finally {
        kill(orphan);
      }
    },
  );
});

describe("B6/B6b diff", () => {
  const SENTINEL = "SECRET_SOURCE_TEXT";
  const k = (
    file: string,
    op: string,
    span: string,
    tuple: string,
    ord: number,
    tag = "",
  ): string => `${file}|${op}|${span}\t${tuple}|${ord}|${tag}`;
  const dump = (keys: string[], specs = keys.length): Dump => ({
    specs,
    hang: 0,
    skipped: 0,
    keys,
  });

  test("parseKeyLine reads format 1 and 2, a tuple holding '|' included", () => {
    expect(parseKeyLine("f|op|1-2\ta|b|3", 1)).toEqual([
      "f|op|1-2",
      { tuple: "a|b", ord: "3", tag: undefined },
    ]);
    expect(parseKeyLine("f|op|1-2\ta|b|3|tag", 2)).toEqual([
      "f|op|1-2",
      { tuple: "a|b", ord: "3", tag: "tag" },
    ]);
  });
  test("B6 exact added / removed / tuples / ordinals / tags counts, and no tuple text", () => {
    const master = new Map([
      [
        "app",
        dump([
          k("a.al", "op1", "1-2", `${SENTINEL}1`, 0),
          k("a.al", "op1", "3-4", `${SENTINEL}2`, 0),
          k("a.al", "op2", "5-6", `${SENTINEL}3`, 0, "write-txn-codeunit-run"),
          k("b.al", "op1", "7-8", `${SENTINEL}4`, 0),
          k("b.al", "op1", "9-9", `${SENTINEL}5`, 1),
        ]),
      ],
    ]);
    const branch = new Map([
      [
        "app",
        dump([
          k("a.al", "op1", "1-2", `${SENTINEL}1`, 0),
          k("a.al", "op1", "3-4", `${SENTINEL}X`, 0),
          k("a.al", "op2", "5-6", `${SENTINEL}3`, 0, ""),
          k("b.al", "op1", "9-9", `${SENTINEL}5`, 0),
          k("c.al", "op3", "1-1", `${SENTINEL}6`, 0),
          k("c.al", "op3", "2-2", `${SENTINEL}7`, 0),
        ]),
      ],
    ]);
    const r = diffDumps(master, branch, 2);
    const text = r.lines.join("\n");
    expect(r.different).toBe(true);
    expect(text).not.toContain(SENTINEL);
    expect(text).toContain("  added 2\n    2\tc.al op3");
    expect(text).toContain("  removed 1\n    1\tb.al op1");
    expect(text).toContain("tuples moved 1; ordinals moved 1; tags changed 1");
    expect(text).toContain("specs 5 -> 6");
    expect(text).toContain("  tags write-txn-codeunit-run -> (none): 1");
    expect(text).toContain("RESULT: different");
  });
  test("B6 against a format-1 master, tags are n/a", () => {
    const m = new Map([["app", dump(["f|op|1-2\tT|0"])]]);
    const b = new Map([["app", dump([k("f", "op", "1-2", "T", 0, "x")])]]);
    const r = diffDumps(m, b, 1);
    expect(r.different).toBe(false);
    expect(r.lines.join("\n")).toContain("tags changed n/a");
  });
  test("B6b projects are joined by relative path: an inserted project changes no other", () => {
    const one = dump([k("a.al", "op", "1-2", "T", 0)]);
    const two = dump([k("b.al", "op", "1-2", "U", 0)]);
    const master = new Map([
      ["b-app", one],
      ["c-app", two],
    ]);
    const branch = new Map([
      ["a-new", dump([k("z.al", "op", "1-2", "V", 0)])],
      ["b-app", one],
      ["c-app", two],
    ]);
    const r = diffDumps(master, branch, 2);
    expect(r.lines).toContain("only in branch: a-new");
    expect(r.lines.join("\n")).not.toContain("b-app:");
    expect(r.lines.join("\n")).not.toContain("c-app:");
    expect(r.lines.join("\n")).toContain("added 0, removed 0, tuples moved 0, ordinals moved 0");
  });
  test("B6b an error project on either side is refused by name", () => {
    const ok = new Map([["app", dump([k("a", "op", "1-2", "T", 0)])]]);
    const bad = new Map([["app", { error: "boom" } as Dump]]);
    expect(() => diffDumps(ok, bad, 2)).toThrow("branch app: boom");
    expect(() => diffDumps(bad, ok, 2)).toThrow("master app: boom");
  });
  test("B6b empty vs empty is refused, never 'identical'", () => {
    const empty = new Map([["app", dump([])]]);
    expect(() => diffDumps(empty, empty, 2)).toThrow(RefusedError);
    expect(() => diffDumps(new Map(), new Map(), 2)).toThrow(RefusedError);
  });
  test("readEntry joins a legacy fixtures entry by the path below fixtures/", () => {
    const dir = fresh("legacy");
    writeFileSync(join(dir, "projects.tsv"), "0\t/old/tree/fixtures/sandbox-app\n");
    writeFileSync(join(dir, "0.jsonl"), JSON.stringify(dump(["f|op|1-2\tT|0"])));
    const e = readEntry(dir, "fixtures");
    expect(e.format).toBe(1);
    expect([...e.dumps.keys()]).toEqual(["sandbox-app"]);
    expect(e.index.get("0")).toBe("sandbox-app");
  });
});

describe("B7 the dumper on a real fixture", () => {
  test("prod-identity-keys.ts on fixtures/sandbox-data writes format-2 keys with kill tags", () => {
    const out = join(fresh("b7"), "0.jsonl");
    const r = Bun.spawnSync(
      [
        process.execPath,
        join(REPO_ROOT, "scripts", "prod-identity-keys.ts"),
        REPO_ROOT,
        out,
        join(REPO_ROOT, "fixtures", "sandbox-data"),
      ],
      { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" },
    );
    expect(r.exitCode, r.stderr.toString()).toBe(0);
    const j = JSON.parse(readFileSync(out, "utf8")) as Dump & { format: number };
    expect(j.error).toBeUndefined();
    expect(j.format).toBe(2);
    const keys = j.keys ?? [];
    expect(keys.length).toBeGreaterThan(0);
    for (const line of keys) expect(line).toMatch(/\t.*\|\d+\|[a-z-]*$/);
    // Data Commit Ops' remove-commit site carries the R72 mechanism.
    expect(
      keys.some((l) => l.includes("lethal.remove-commit") && l.endsWith("|write-txn-codeunit-run")),
    ).toBe(true);
  });
  test("findProjects finds app.json dirs, sorted, skipping .alpackages", () => {
    const d = fresh("projects");
    write(d, "b/app.json", "{}");
    write(d, "a/app.json", "{}");
    write(d, "a/.alpackages/x/app.json", "{}");
    write(d, "a/nested/app.json", "{}");
    expect(findProjects(d)).toEqual([join(d, "a"), join(d, "a", "nested"), join(d, "b")]);
  });
  test("R631: findProjects never descends a linked folder (a cycle terminates, a link out is not walked)", () => {
    const d = fresh("projects-links");
    write(d, "root/a/app.json", "{}");
    write(d, "foreign/app.json", "{}");
    symlinkSync(join(d, "root"), join(d, "root", "a", "loop"), "junction");
    symlinkSync(join(d, "foreign"), join(d, "root", "out"), "junction");
    expect(findProjects(join(d, "root"))).toEqual([join(d, "root", "a")]);
  });
});
