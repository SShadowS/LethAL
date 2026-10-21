import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type Dump,
  type Git,
  RefusedError,
  corpusHeadOf,
  diffDumps,
  dumperKeyOf,
  entryDir,
  findProjects,
  generationChanged,
  gitIn,
  heavyVerdict,
  isHeavy,
  parseKeyLine,
  parsePs,
  pickMaster,
  readEntry,
  slotHeld,
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

describe("B5 the heavy-job guard", () => {
  const ps = (rows: string[]): string => ["PID PPID PGID COMMAND", ...rows].join("\n");
  const SELF = 100;
  const base = [
    "1 0 1 init",
    "90 1 90 bash -c bun scripts/corpus-snapshot.ts diff dc --branch /w # /work/src/DC wrapper",
    `${SELF} 90 90 bun scripts/corpus-snapshot.ts diff dc --in-slot 1`,
    `101 ${SELF} 90 bun scripts/prod-identity-keys.ts /w /tmp/0.jsonl /work/src/DC/app`,
  ];
  const job = (pid: number, pgid: number, root = "/work/src/BC.History/x"): string =>
    `${pid} 1 ${pgid} bun census.ts ${root}`;
  test("0, 1 or 2 foreign process groups -> go, go, refuse; self, ancestors and children not counted", () => {
    expect(heavyVerdict(parsePs(ps(base)), SELF, [], 0).refuse).toBe(false);
    expect(heavyVerdict(parsePs(ps([...base, job(200, 200)])), SELF, [], 0).refuse).toBe(false);
    const two = heavyVerdict(parsePs(ps([...base, job(200, 200), job(300, 300)])), SELF, [], 0);
    expect(two.refuse).toBe(true);
    expect(two.foreign.map((p) => p.pid)).toEqual([200, 300]);
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
    ).toBe(true);
  });
  test("/work/src/DOX is not the DO corpus", () => {
    const v = heavyVerdict(parsePs(ps([...base, job(200, 200, "/work/src/DOX/a")])), SELF, [], 0);
    expect(v.foreign).toEqual([]);
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
    // With one corpus job beside it, that is two others: refuse.
    expect(heavyVerdict(parsePs(ps([...base, ...run, job(800, 800)])), SELF, [], 0).refuse).toBe(
      true,
    );
    // A unit test run named after al-runner beside a corpus job is not a second job.
    const unit = "900 1 900 bun test packages/runner/tests/al-runner-v3-backend.test.ts";
    expect(heavyVerdict(parsePs(ps([...base, unit, job(800, 800)])), SELF, [], 0).refuse).toBe(
      false,
    );
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
  posix(
    "both slots held by live holders -> refused; slot 1 busy, slot 2 free -> slot 2",
    async () => {
      const dir = fresh("locks");
      const one = await hold(join(dir, "heavy.1"));
      try {
        expect(trySlots(dir, () => ["true"])).toEqual({ slot: 2, code: 0 });
        const two = await hold(join(dir, "heavy.2"));
        try {
          expect(trySlots(dir, () => ["true"])).toBeNull();
        } finally {
          kill(two.pid);
        }
      } finally {
        kill(one.pid);
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
});
