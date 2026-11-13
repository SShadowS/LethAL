import { afterAll, test as bunTest, describe, expect } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RefusedError,
  SLOTS,
  guardInSlot,
  heavyVerdict,
  parsePs,
  slotHeld,
} from "./corpus-snapshot.ts";
import { memoryVerdict, parsePeak, readSlot, readSlotClass } from "./heavy-slot-class.ts";

// R905. Every lock dir here is a temp dir; nothing touches /coord.
// Not `lethal-*`: the R358 preload check would read a leftover as this file's leak.
const TMP = mkdtempSync(join(tmpdir(), "heavy-slot-class-test-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
let seq = 0;
const fresh = (): string => {
  const d = join(TMP, `d${seq++}`);
  mkdirSync(d, { recursive: true });
  return d;
};
const test = process.platform === "win32" ? bunTest.skip : bunTest;
const PS = parsePs(["PID PPID PGID COMMAND", "1 0 1 init", "100 1 100 bun x.ts"].join("\n"));
const verdict = (
  held: readonly ("baseapp" | "other" | undefined)[],
  selfBaseApp = false,
): ReturnType<typeof heavyVerdict> => heavyVerdict(PS, 100, [], held.length, selfBaseApp, held);

describe("R905 slot class in the heavy-job guard", () => {
  test("a baseapp holder plus one other held slot: a third job is refused", () => {
    const v = verdict(["baseapp", "other"]);
    expect(v.refuse).toBe(true);
    expect(v.message).toContain("a BaseApp-class job runs");
  });
  test("two held slots, both class other: a third job is allowed", () => {
    const v = verdict(["other", "other"]);
    expect(v.refuse).toBe(false);
    expect(v.message).not.toContain("REFUSED");
  });
  test("a held slot with NO class counts as BaseApp: a third job is refused", () => {
    expect(verdict([undefined, "other"]).refuse).toBe(true);
  });
  test("a job that is itself BaseApp is refused with two other slots held, even both other", () => {
    expect(verdict(["other", "other"], true).refuse).toBe(true);
    expect(verdict(["other"], true).refuse).toBe(false);
  });
  test("an unslotted job naming the BaseApp root holds the cap at two; an unslotted job elsewhere does not", () => {
    const ps = (root: string) =>
      parsePs(
        [
          "PID PPID PGID COMMAND",
          "1 0 1 init",
          "100 1 100 bun x.ts",
          `200 1 200 bun scripts/corpus-snapshot.ts snapshot --root ${root}`,
        ].join("\n"),
      );
    const onBaseApp = heavyVerdict(ps("/work/src/BC.History/BaseApp"), 100, [], 2, false, [
      "other",
      "other",
    ]);
    expect(onBaseApp.foreign.length).toBe(1);
    expect(onBaseApp.refuse).toBe(true);
    const elsewhere = heavyVerdict(ps("/work/src/DO"), 100, [], 2, false, ["other", "other"]);
    expect(elsewhere.foreign.length).toBe(1);
    expect(elsewhere.refuse).toBe(false);
  });
  // R905 follow-up (lethal-bugs): a bare-flock holder writes no pid, so it is a held slot AND a foreign job. One job, not two.
  describe("an untrusted (bare-flock) slot and its own process count once", () => {
    const row = (pid: number, root: string) => `${pid} 1 ${pid} bun census.ts ${root}`;
    const psOf = (...rows: string[]) =>
      parsePs(["PID PPID PGID COMMAND", "1 0 1 init", "100 1 100 bun x.ts", ...rows].join("\n"));
    test("one bare-flock job on a corpus copy leaves room for a second job", () => {
      const v = heavyVerdict(psOf(row(200, "/work/src/DC/x")), 100, [], 1, false, [undefined]);
      expect(v.foreign.length).toBe(1);
      expect(v.refuse).toBe(false);
    });
    test("two bare-flock slots, or one plus two foreign jobs, still fill the two-job cap", () => {
      const a = psOf(row(200, "/work/src/DC/x"), row(300, "/work/src/DC/y"));
      expect(heavyVerdict(a, 100, [], 2, false, [undefined, undefined]).refuse).toBe(true);
      expect(heavyVerdict(a, 100, [], 1, false, [undefined]).refuse).toBe(true);
    });
  });
  test("three other-class slots held: a fourth is still refused (cap 3)", () => {
    expect(verdict(["other", "other", "other"]).refuse).toBe(true);
  });
});

describe("R905 the class file", () => {
  test("a class file whose pid is dead reads as no class; a live pid reads its class", () => {
    const dir = fresh();
    const dead = Bun.spawnSync(["true"]);
    writeFileSync(join(dir, "heavy.1.class"), `baseapp ${dead.pid}\n`);
    expect(readSlotClass(dir, 1)).toBeUndefined();
    writeFileSync(join(dir, "heavy.1.class"), `baseapp ${process.pid}\n`);
    expect(readSlotClass(dir, 1)).toBe("baseapp");
    writeFileSync(join(dir, "heavy.2.class"), `other ${process.pid}\n`);
    expect(readSlotClass(dir, 2)).toBe("other");
    expect(readSlotClass(dir, 3)).toBeUndefined();
    writeFileSync(join(dir, "heavy.3.class"), "garbage\n");
    expect(readSlotClass(dir, 3)).toBeUndefined();
  });
  test("the helper writes the class on acquire and removes it on exit", () => {
    const dir = fresh();
    const code = `import { writeSlotClass, readSlotClass } from ${JSON.stringify(join(import.meta.dir, "heavy-slot-class.ts"))};
writeSlotClass(${JSON.stringify(dir)}, 2, "baseapp");
console.log(readSlotClass(${JSON.stringify(dir)}, 2));`;
    const r = Bun.spawnSync([process.execPath, "-e", code]);
    expect(r.stdout.toString().trim()).toBe("baseapp");
    expect(existsSync(join(dir, "heavy.2.class"))).toBe(false);
  });
  test("guardInSlot writes its own class (baseapp for a BaseApp job)", () => {
    const dir = fresh();
    const old = process.env.LETHAL_HEAVY_LOCK_DIR;
    process.env.LETHAL_HEAVY_LOCK_DIR = dir;
    try {
      guardInSlot(
        1,
        true,
        () => {},
        () => "PID PPID PGID COMMAND\n1 0 1 init",
      );
      // R952: the class file carries the expected peak (baseapp's default, 12 GiB)
      expect(readFileSync(join(dir, "heavy.1.class"), "utf8")).toBe(`baseapp ${process.pid} 12\n`);
    } finally {
      if (old === undefined) Reflect.deleteProperty(process.env, "LETHAL_HEAVY_LOCK_DIR");
      else process.env.LETHAL_HEAVY_LOCK_DIR = old;
    }
  });
});

// Real flock holders on temp lock files. The holder BLOCKS on the lock (our probes take it briefly).
const holders: number[] = [];
afterAll(() => {
  for (const pid of holders) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
});
async function hold(dir: string, slot: number, cls: "baseapp" | "other" | "none"): Promise<void> {
  const lock = join(dir, `heavy.${slot}`);
  const p = Bun.spawn(["bash", "-c", `exec 9>>"${lock}" && flock 9 && exec sleep 30`], {
    stdout: "ignore",
    stderr: "ignore",
  });
  holders.push(p.pid);
  for (let i = 0; i < 100 && !slotHeld(dir, slot); i++) await Bun.sleep(20);
  if (!slotHeld(dir, slot)) throw new Error(`could not hold ${lock}`);
  if (cls !== "none") writeFileSync(join(dir, `heavy.${slot}.class`), `${cls} ${p.pid}\n`);
}

describe("R905 scripts/heavy-slot.sh", () => {
  const script = join(import.meta.dir, "heavy-slot.sh");
  const EMPTY_PS = "PID PPID PGID COMMAND\n1 0 1 init\n";
  const run = (dir: string, cls: string, ...cmd: string[]) => {
    const psFile = join(dir, "ps.txt"); // the guard's ps seam: no live process decides these tests
    writeFileSync(psFile, EMPTY_PS);
    return Bun.spawnSync(["bash", script, cls, ...cmd], {
      env: {
        ...process.env,
        LETHAL_HEAVY_LOCK_DIR: dir,
        BUN: process.execPath,
        LETHAL_HEAVY_PS_FILE: psFile,
      },
    });
  };
  test("writes the class while the command runs, removes it after, keeps the exit code", () => {
    const dir = fresh();
    const r = run(dir, "other", "sh", "-c", `cat "${dir}/heavy.1.class" "${dir}/heavy.1"; exit 7`);
    // the class file and the lock file name the same pid (the wrapper's)
    expect(r.stdout.toString()).toMatch(/^other (\d+) 8\n\1\n$/); // R952: other's default peak
    expect(r.exitCode).toBe(7);
    expect(existsSync(join(dir, "heavy.1.class"))).toBe(false);
    expect(run(dir, "bogus", "true").exitCode).toBe(2);
    // R934 review: `other --wait cmd` would hold a slot and run a command named --wait
    const misplaced = run(dir, "other", "--wait", "touch", join(dir, "ran"));
    expect(misplaced.exitCode).toBe(2);
    expect(existsSync(join(dir, "ran"))).toBe(false);
  });
  test("two held baseapp slots: the wrapper exits 75 and does not run the command", async () => {
    const dir = fresh();
    await hold(dir, 1, "baseapp");
    await hold(dir, 2, "baseapp");
    const marker = join(dir, "ran");
    const r = run(dir, "other", "touch", marker);
    expect(r.exitCode).toBe(75);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(dir, "heavy.3.class"))).toBe(false);
    // R-963 review: a guard refusal names itself, apart from "all heavy slots held"
    expect(r.stderr.toString()).toContain("the guard refused");
    expect(r.stderr.toString()).not.toContain("all heavy slots held");
  });
  test("two held other slots: the wrapper runs the command", async () => {
    const dir = fresh();
    await hold(dir, 1, "other");
    await hold(dir, 2, "other");
    const marker = join(dir, "ran");
    const r = run(dir, "other", "touch", marker);
    expect(r.exitCode).toBe(0);
    expect(existsSync(marker)).toBe(true);
  });
  // R-963: EVERY slot (SLOTS), so the exit 75 is "all held", not the count fallback's refusal.
  test("all slots held: exit 75, and a busy slot's pid in the lock file survives", async () => {
    const dir = fresh();
    for (const n of SLOTS) writeFileSync(join(dir, `heavy.${n}`), "12345\n");
    for (const n of SLOTS) await hold(dir, n, "other");
    const r = run(dir, "other", "true");
    expect(r.exitCode).toBe(75);
    expect(r.stderr.toString()).toContain("all heavy slots held");
    for (const n of SLOTS) expect(readFileSync(join(dir, `heavy.${n}`), "utf8")).toBe("12345\n");
  });
  test("a flock failure other than busy is exit 2, not 75", () => {
    const dir = fresh();
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "flock"), "#!/bin/sh\nexit 3\n", { mode: 0o755 });
    const r = Bun.spawnSync(["bash", script, "other", "true"], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, LETHAL_HEAVY_LOCK_DIR: dir },
    });
    expect(r.exitCode).toBe(2);
  });
  test("a bad lock folder is exit 2, not 75 (a retry loop must not spin)", () => {
    const dir = fresh();
    const notADir = join(dir, "file");
    writeFileSync(notADir, "x");
    const r = Bun.spawnSync(["bash", script, "other", "true"], {
      env: { ...process.env, LETHAL_HEAVY_LOCK_DIR: notADir, BUN: process.execPath },
    });
    expect(r.exitCode).toBe(2);
  });
});

describe("R905 guardInSlot reads the held slots' classes", () => {
  const go = async (cls: "baseapp" | "other"): Promise<unknown> => {
    const dir = fresh();
    await hold(dir, 2, cls);
    await hold(dir, 3, cls);
    const old = process.env.LETHAL_HEAVY_LOCK_DIR;
    process.env.LETHAL_HEAVY_LOCK_DIR = dir;
    try {
      guardInSlot(
        1,
        false,
        () => {},
        () => "PID PPID PGID COMMAND\n1 0 1 init",
      );
      return undefined;
    } catch (e) {
      return e;
    } finally {
      if (old === undefined) Reflect.deleteProperty(process.env, "LETHAL_HEAVY_LOCK_DIR");
      else process.env.LETHAL_HEAVY_LOCK_DIR = old;
    }
  };
  test("two held baseapp slots refuse a third job; two held other slots do not", async () => {
    expect(await go("baseapp")).toBeInstanceOf(RefusedError);
    expect(await go("other")).toBeUndefined();
  });
});

describe("R905 a heavy-slot.sh holder is trusted, so its job counts once", () => {
  const wrapper = (pid: number, cls: string): string[] => [
    `${pid} 1 ${pid} /bin/bash scripts/heavy-slot.sh ${cls} /work/tools/al-runner-v3/current/al-runner test x`,
    `${pid + 1} ${pid} ${pid + 1} /work/tools/al-runner-v3/current/al-runner test x`,
  ];
  const psOf = (rows: string[]) =>
    parsePs(["PID PPID PGID COMMAND", "1 0 1 init", "100 1 100 bun g.ts", ...rows].join("\n"));
  test("two other wrappers running al-runner allow a third job", () => {
    const v = heavyVerdict(
      psOf([...wrapper(500, "other"), ...wrapper(600, "other")]),
      100,
      [500, 600],
      2,
      false,
      ["other", "other"],
    );
    expect(v.foreign).toEqual([]);
    expect(v.refuse).toBe(false);
  });
  test("one baseapp wrapper plus one other wrapper refuse a third job", () => {
    const v = heavyVerdict(
      psOf([...wrapper(500, "baseapp"), ...wrapper(600, "other")]),
      100,
      [500, 600],
      2,
      false,
      ["baseapp", "other"],
    );
    expect(v.foreign).toEqual([]);
    expect(v.refuse).toBe(true);
  });
  test("a wrapper's BaseApp status is its class: two baseapp wrappers hit the BaseApp cap for a BaseApp job", () => {
    const v = heavyVerdict(
      psOf([...wrapper(500, "baseapp"), ...wrapper(600, "baseapp")]),
      100,
      [500, 600],
      2,
      true,
      ["baseapp", "baseapp"],
    );
    expect(v.refuse).toBe(true);
    expect(v.message).toContain("at most two BaseApp corpus jobs");
  });
  test("one baseapp wrapper alone, its child naming the BaseApp root, allows a second job", () => {
    const rows = wrapper(500, "baseapp");
    rows[1] = "501 500 501 /work/tools/al-runner-v3/current/al-runner test /work/src/BC.History/x";
    const v = heavyVerdict(psOf(rows), 100, [500], 1, false, ["baseapp"]);
    expect(v.foreign).toEqual([]);
    expect(v.refuse).toBe(false);
  });
  test("R934: a --wait holder is trusted like any wrapper; a --wait waiter holding no slot is no job", () => {
    const holder = wrapper(500, "--wait other");
    const waiter =
      "700 1 700 /bin/bash scripts/heavy-slot.sh --wait baseapp bun x.ts /work/src/BC.History/BaseApp";
    const v = heavyVerdict(psOf([...holder, waiter]), 100, [500], 1, false, ["other"]);
    expect(v.foreign).toEqual([]);
    expect(v.refuse).toBe(false);
  });
  test("R952: a --peak holder is trusted and a --peak waiter is no job; a job that only mentions it is a job", () => {
    const holder = wrapper(500, "--wait --peak gate other");
    const waiter =
      "700 1 700 /bin/bash scripts/heavy-slot.sh --wait --peak 30 baseapp bun x.ts /work/src/BC.History/BaseApp";
    const v = heavyVerdict(psOf([...holder, waiter]), 100, [500], 1, false, ["other"]);
    expect(v.foreign).toEqual([]);
    // the counted direction: not heavy-slot.sh, so its BaseApp job is foreign
    const lookalike =
      "800 1 800 bun x.ts --log scripts/heavy-slot.sh --wait baseapp /work/src/BC.History/BaseApp";
    const w = heavyVerdict(psOf([...holder, lookalike]), 100, [500], 1, false, ["other"]);
    expect(w.foreign.length).toBe(1);
  });
  // R952 review (reproduced): the Bash tool runs `bash -c source snap.sh && eval '... heavy-slot.sh ...'`
  // in a group of its own, and that shell names the job. It is the launcher, not a second job.
  const job = "bun x.ts /work/src/BC.History/BaseApp";
  const launcher = (pid: number, wrapperArgs: string) =>
    `${pid} 1 ${pid} /bin/bash -c source /tmp/snap.sh && eval 'cd /w && bash scripts/heavy-slot.sh ${wrapperArgs} ${job}'`;
  test("R952: the shell that launched a holding wrapper is no job; the slot is the job", () => {
    const rows = [
      launcher(400, "baseapp"),
      `501 400 501 bash scripts/heavy-slot.sh baseapp ${job}`,
      `502 501 501 ${job}`,
    ];
    const v = heavyVerdict(psOf(rows), 100, [501], 1, false, ["baseapp"]);
    expect(v.foreign).toEqual([]);
    expect(v.refuse).toBe(false);
  });
  test("R952: the shell that launched a queued waiter is no job either", () => {
    const rows = [
      launcher(600, "--wait --peak 4 baseapp"),
      `601 600 601 bash scripts/heavy-slot.sh --wait --peak 4 baseapp ${job}`,
    ];
    const v = heavyVerdict(psOf(rows), 100, [], 0, false, []);
    expect(v.foreign).toEqual([]);
  });
});

describe("R934 heavy-slot.sh --wait: a FIFO queue", () => {
  const script = join(import.meta.dir, "heavy-slot.sh");
  const EMPTY_PS = "PID PPID PGID COMMAND\n1 0 1 init\n";
  const start = (dir: string, poll: string, ...args: string[]) =>
    startIn(dir, undefined, poll, ...args);
  /** R-963: `cg` names a fake cgroup folder (the memory rule decides, as in the container); none = no limit. */
  const startIn = (dir: string, cg: string | undefined, poll: string, ...args: string[]) => {
    const psFile = join(dir, "ps.txt");
    writeFileSync(psFile, EMPTY_PS);
    return Bun.spawn(["bash", script, ...args], {
      env: {
        ...process.env,
        LETHAL_HEAVY_LOCK_DIR: dir,
        BUN: process.execPath,
        LETHAL_HEAVY_PS_FILE: psFile,
        LETHAL_HEAVY_POLL_S: poll,
        ...(cg !== undefined ? { LETHAL_HEAVY_CGROUP_DIR: cg } : {}),
      },
      stdout: "ignore",
      stderr: "ignore",
    });
  };
  /** A real holder of slot `n`, killable by pid. */
  const holdSlot = async (dir: string, n: number, cls: "baseapp" | "other"): Promise<number> => {
    const lock = join(dir, `heavy.${n}`);
    const p = Bun.spawn(["bash", "-c", `exec 9>>"${lock}" && flock 9 && exec sleep 60`], {
      stdout: "ignore",
      stderr: "ignore",
    });
    holders.push(p.pid);
    for (let i = 0; i < 100 && !slotHeld(dir, n); i++) await Bun.sleep(20);
    writeFileSync(join(dir, `heavy.${n}.class`), `${cls} ${p.pid}\n`);
    return p.pid;
  };
  const tickets = (dir: string) => {
    try {
      return readdirSync(join(dir, "heavy-queue"));
    } catch {
      return [];
    }
  };
  const until = async (cond: () => boolean, ms = 8000) => {
    for (let t = 0; t < ms && !cond(); t += 25) await Bun.sleep(25);
    return cond();
  };

  test("the order is kept: the older waiter runs first, even when the younger polls faster", async () => {
    const dir = fresh();
    // R-963: EVERY slot is held (R960 raised them to six; holding three left three free, so a waiter
    // could run at once, before the queue was set up: 2 failures in 12). Only slot 1 is ever freed.
    // A roomy fake cgroup (1 of 64 GiB) makes the memory rule decide, as in the container: with no
    // limit, the count fallback would refuse beside five held slots and nobody would ever run.
    const pids: number[] = [];
    for (const n of SLOTS) pids.push(await holdSlot(dir, n, "other"));
    const cg = join(dir, "cgroup");
    mkdirSync(cg);
    writeFileSync(join(cg, "memory.current"), `${2 ** 30}\n`);
    writeFileSync(join(cg, "memory.max"), `${64 * 2 ** 30}\n`);
    const order = join(dir, "order");
    const a = startIn(dir, cg, "0.4", "--wait", "other", "sh", "-c", `echo A >> "${order}"`);
    expect(await until(() => tickets(dir).length === 1)).toBe(true);
    const b = startIn(dir, cg, "0.02", "--wait", "other", "sh", "-c", `echo B >> "${order}"`);
    expect(await until(() => tickets(dir).length === 2)).toBe(true);
    process.kill(pids[0] ?? 0, "SIGKILL");
    await a.exited;
    await b.exited;
    expect(readFileSync(order, "utf8")).toBe("A\nB\n");
    expect(tickets(dir)).toEqual([]);
  });

  test("a dead waiter's ticket does not block the queue", async () => {
    const dir = fresh();
    mkdirSync(join(dir, "heavy-queue"), { recursive: true });
    const dead = Bun.spawnSync(["true"]).pid;
    writeFileSync(join(dir, "heavy-queue", `000000000001.${dead}`), "");
    writeFileSync(join(dir, "heavy-queue.seq"), "1\n");
    const marker = join(dir, "ran");
    const w = start(dir, "0.05", "--wait", "other", "touch", marker);
    expect(await w.exited).toBe(0);
    expect(existsSync(marker)).toBe(true);
    expect(tickets(dir)).toEqual([]);
  });

  test("no cgroup (count rule): with two BaseApp slots held a waiter waits, and runs once one frees", async () => {
    const dir = fresh();
    const p1 = await holdSlot(dir, 1, "baseapp");
    await holdSlot(dir, 2, "baseapp");
    const marker = join(dir, "ran");
    const w = start(dir, "0.05", "--wait", "other", "touch", marker);
    expect(await until(() => tickets(dir).length === 1)).toBe(true);
    await Bun.sleep(400);
    expect(existsSync(marker)).toBe(false);
    process.kill(p1, "SIGKILL");
    expect(await w.exited).toBe(0);
    expect(existsSync(marker)).toBe(true);
  });

  test("a caller without --wait does not overtake a live waiter for a slot that just freed", async () => {
    const dir = fresh();
    const p1 = await holdSlot(dir, 1, "other");
    for (const n of SLOTS.slice(1)) await holdSlot(dir, n, "other"); // every slot held (R-963: SLOTS)
    // The waiter polls every 30 s, so the freed slot stays free while the plain caller tries.
    const w = start(dir, "30", "--wait", "other", "true");
    expect(await until(() => tickets(dir).length === 1)).toBe(true);
    await Bun.sleep(200);
    process.kill(p1, "SIGKILL");
    expect(await until(() => !slotHeld(dir, 1))).toBe(true);
    const plain = start(dir, "0.05", "other", "touch", join(dir, "plain"));
    expect(await plain.exited).toBe(75);
    expect(existsSync(join(dir, "plain"))).toBe(false);
    w.kill("SIGKILL");
  });

  // Review: a waiter SIGKILLed whose pid is reused by an unrelated process must not block forever.
  test("a ticket whose live pid is not a heavy-slot.sh is dropped", async () => {
    const dir = fresh();
    mkdirSync(join(dir, "heavy-queue"), { recursive: true });
    const other = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    holders.push(other.pid);
    writeFileSync(join(dir, "heavy-queue", `000000000001.${other.pid}`), "");
    const plain = start(dir, "0.05", "other", "touch", join(dir, "plain"));
    expect(await plain.exited).toBe(0);
    expect(existsSync(join(dir, "plain"))).toBe(true);
    expect(tickets(dir)).toEqual([]);
  });

  // Review: a head waiter the guard refuses (baseapp over the two-job cap, a slot free) must not keep
  // an `other` job, which the cap admits, out of that slot.
  // R967 (R952): hermetic. Every guard here reads the injected empty `ps` (LETHAL_HEAVY_PS_FILE), a
  // temp lock folder and, through the preload, no cgroup; the flake was the waiter's own out-of-turn
  // retry holding the free slot for the length of its guard while the plain caller tried. So the
  // waiter polls every 30 s: it marks itself on its FIRST try (before any sleep) and then sleeps
  // through the whole plain call. That it still runs once a job ends is the next test, with no
  // plain caller to race.
  test("a guard-refused head waiter marks itself and lets a plain caller take the free slot", async () => {
    const dir = fresh();
    await holdSlot(dir, 1, "other");
    await holdSlot(dir, 2, "other");
    const marker = join(dir, "ba");
    const w = start(dir, "30", "--wait", "baseapp", "touch", marker);
    expect(await until(() => tickets(dir).some((t) => t.endsWith(".refused")))).toBe(true);
    const plain = start(dir, "0.05", "other", "touch", join(dir, "plain"));
    expect(await plain.exited).toBe(0);
    expect(existsSync(join(dir, "plain"))).toBe(true);
    expect(existsSync(marker)).toBe(false);
    w.kill("SIGKILL");
  });

  test("a guard-refused waiter stays a waiter: once a job ends it runs, and its ticket and marker go", async () => {
    const dir = fresh();
    const p1 = await holdSlot(dir, 1, "other");
    await holdSlot(dir, 2, "other");
    const marker = join(dir, "ba");
    const w = start(dir, "0.05", "--wait", "baseapp", "touch", marker);
    expect(await until(() => tickets(dir).some((t) => t.endsWith(".refused")))).toBe(true);
    expect(existsSync(marker)).toBe(false);
    process.kill(p1, "SIGKILL");
    expect(await w.exited).toBe(0);
    expect(existsSync(marker)).toBe(true);
    expect(tickets(dir)).toEqual([]);
  });
});

describe("R952 (R953) admission by memory", () => {
  const GIB = 2 ** 30;
  const sample = (usedGiB: number, maxGiB?: number) => ({
    usedBytes: usedGiB * GIB,
    ...(maxGiB !== undefined ? { maxBytes: maxGiB * GIB } : {}),
    source: "/fake/memory.max",
  });
  test("admitted when used + peak + reserve and held peaks + peak + reserve both fit", () => {
    expect(memoryVerdict(sample(10, 32), [2], 16).refuse).toBe(false); // 10+16+4=30, 2+16+4=22
    expect(memoryVerdict(sample(12, 32), [], 16).refuse).toBe(false); // 12+16+4 = 32 exactly
  });
  test("refused when what is used now leaves no room for the peak", () => {
    const v = memoryVerdict(sample(13, 32), [], 16); // 13+16+4 = 33
    expect(v.refuse).toBe(true);
    expect(v.message).toContain("used + peak + reserve = 33.0");
  });
  test("refused when the held slots' declared peaks leave no room, though little is used yet", () => {
    const v = memoryVerdict(sample(3, 32), [16], 16); // 3+16+4 fits now; 16+16+4 = 36 does not
    expect(v.refuse).toBe(true);
    expect(v.message).toContain("held peaks + peak + reserve = 36.0");
    expect(memoryVerdict(sample(3, 32), [16], 2).refuse).toBe(false); // a gate still fits beside a serve run
  });
  test("no cgroup, or a cgroup with no limit: admitted, and the message says the rule is off", () => {
    expect(memoryVerdict(undefined, [16, 16], 16)).toEqual({
      refuse: false,
      off: true,
      message: "memory rule off: no cgroup v2 memory.current can be read",
    });
    const v = memoryVerdict(sample(31), [16, 16], 16);
    expect(v.refuse).toBe(false);
    expect(v.message).toBe("memory rule off: /fake/memory.max names no limit");
  });
  test("parsePeak: the four names, a positive number, nothing else", () => {
    expect(["serve", "baseline", "gate", "build", "2.5"].map(parsePeak)).toEqual([
      8, 12, 2, 1, 2.5,
    ]);
    expect(["0", "-1", "x", "", "toString", "1e3"].map(parsePeak)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });
  test("readSlot: a declared peak, the class default for a file without one, nothing for a dead pid", () => {
    const dir = fresh();
    writeFileSync(join(dir, "heavy.1.class"), `other ${process.pid} 2\n`);
    writeFileSync(join(dir, "heavy.2.class"), `baseapp ${process.pid}\n`);
    const dead = Bun.spawnSync(["true"]).pid;
    writeFileSync(join(dir, "heavy.3.class"), `other ${dead} 2\n`);
    expect(readSlot(dir, 1)).toEqual({ cls: "other", peakGiB: 2 });
    expect(readSlot(dir, 2)).toEqual({ cls: "baseapp", peakGiB: 12 });
    expect(readSlot(dir, 3)).toBeUndefined();
  });

  describe("scripts/heavy-slot.sh with injected cgroup readings", () => {
    const script = join(import.meta.dir, "heavy-slot.sh");
    const cgroup = (usedGiB: number, maxGiB: number): string => {
      const d = fresh();
      writeFileSync(join(d, "memory.current"), `${usedGiB * GIB}\n`);
      writeFileSync(join(d, "memory.max"), `${maxGiB * GIB}\n`);
      writeFileSync(join(d, "memory.stat"), "inactive_file 0\n");
      return d;
    };
    const run = (dir: string, cg: string, ...args: string[]) => {
      const psFile = join(dir, "ps.txt");
      writeFileSync(psFile, "PID PPID PGID COMMAND\n1 0 1 init\n");
      return Bun.spawnSync(["bash", script, ...args], {
        env: {
          ...process.env,
          LETHAL_HEAVY_LOCK_DIR: dir,
          BUN: process.execPath,
          LETHAL_HEAVY_PS_FILE: psFile,
          LETHAL_HEAVY_CGROUP_DIR: cg,
        },
      });
    };
    test("a job whose default peak does not fit exits 75 and does not run; --peak gate fits and runs", () => {
      const dir = fresh();
      const cg = cgroup(21, 32); // 21 + 8 (other's default) + 4 = 33 > 32; 21 + 2 + 4 = 27
      const ran = join(dir, "ran");
      const r = run(dir, cg, "other", "touch", ran);
      expect(r.exitCode).toBe(75);
      expect(existsSync(ran)).toBe(false);
      expect(r.stderr.toString()).toContain("REFUSED (used + peak + reserve = 33.0 > 32.0)");
      const g = run(dir, cg, "--peak", "gate", "other", "sh", "-c", `cat "${dir}/heavy.1.class"`);
      expect(g.exitCode).toBe(0);
      expect(g.stdout.toString()).toMatch(/^other \d+ 2\n$/);
    });
    test("a held slot's declared peak counts while its job is young; two capped serve runs fit", async () => {
      const dir = fresh();
      await hold(dir, 1, "other");
      const pid = holders.at(-1);
      if (pid === undefined) throw new Error("no holder");
      writeFileSync(join(dir, "heavy.1.class"), `other ${pid} 21\n`); // declares 21 GiB, uses ~nothing yet
      const cg = cgroup(3, 32);
      expect(run(dir, cg, "--peak", "serve", "other", "true").exitCode).toBe(75); // 21 + 8 + 4 = 33
      expect(run(dir, cg, "--peak", "build", "other", "true").exitCode).toBe(0); // 21 + 1 + 4 = 26
      // an undeclared held `other` slot reads as its default, 8: a serve run fits beside it (8 + 8 + 4)
      writeFileSync(join(dir, "heavy.1.class"), `other ${pid}\n`);
      expect(run(dir, cg, "--peak", "serve", "other", "true").exitCode).toBe(0);
    });
    test("a bad or misplaced --peak is exit 2, and nothing runs", () => {
      const dir = fresh();
      const cg = cgroup(1, 32);
      const ran = join(dir, "ran");
      for (const args of [
        ["--peak", "huge", "other", "touch", ran],
        ["--peak", "0", "other", "touch", ran],
        ["other", "--peak", "gate", "touch", ran],
      ])
        expect(run(dir, cg, ...args).exitCode).toBe(2);
      expect(existsSync(ran)).toBe(false);
    });
    // R960 (owner ruling 2026-11-13): with a cgroup limit, memory is the only rule. Three held
    // BaseApp-class slots (the old cap: two jobs in all) do not refuse a job that fits; with no cgroup
    // limit, the old count rule still decides.
    test("R960: memory alone decides; three held BaseApp slots no longer refuse a job that fits", async () => {
      const dir = fresh();
      for (const n of [1, 2, 3]) {
        await hold(dir, n, "baseapp");
        const pid = holders.at(-1);
        if (pid === undefined) throw new Error("no holder");
        writeFileSync(join(dir, `heavy.${n}.class`), `baseapp ${pid} 2\n`); // small declared peaks
      }
      const ran = join(dir, "ran");
      const fits = run(dir, cgroup(5, 32), "--peak", "gate", "baseapp", "touch", ran); // 5+2+4, 6+2+4
      expect(fits.exitCode).toBe(0);
      expect(existsSync(ran)).toBe(true);
      // the same slots on a host with no cgroup limit: the count rule (two jobs with BaseApp) refuses
      const host = run(dir, join(dir, "no-cgroup"), "--peak", "gate", "baseapp", "true");
      expect(host.exitCode).toBe(75);
      expect(host.stderr.toString()).toContain("memory rule off");
    });
    test("R960: with no slot held at all, a job whose peak does not fit is still refused", () => {
      const dir = fresh();
      const r = run(dir, cgroup(25, 32), "--peak", "serve", "other", "true"); // 25 + 8 + 4 = 37
      expect(r.exitCode).toBe(75);
      expect(r.stderr.toString()).toContain("REFUSED (used + peak + reserve = 37.0 > 32.0)");
    });
  });

  test("R960: guardInSlot decides by memory alone where the cgroup names a limit", async () => {
    const dir = fresh();
    const cg = fresh();
    writeFileSync(join(cg, "memory.current"), `${4 * GIB}\n`);
    writeFileSync(join(cg, "memory.max"), `${32 * GIB}\n`);
    const old = {
      lock: process.env.LETHAL_HEAVY_LOCK_DIR,
      cg: process.env.LETHAL_HEAVY_CGROUP_DIR,
    };
    process.env.LETHAL_HEAVY_LOCK_DIR = dir;
    process.env.LETHAL_HEAVY_CGROUP_DIR = cg;
    const psOf =
      (...rows: string[]) =>
      () =>
        ["PID PPID PGID COMMAND", "1 0 1 init", ...rows].join("\n");
    const census = (pid: number) => `${pid} 1 ${pid} bun census.ts /work/src/BC.History/BaseApp`;
    try {
      // (A) review r1: two young BaseApp jobs in no slot reserve their default peaks (12 each), which
      // memory.current (4) does not show: 12 + 12 + 12 + 4 = 40 > 32, refused.
      expect(() => guardInSlot(1, true, () => {}, psOf(census(700), census(800)))).toThrow(
        RefusedError,
      );
      // (B) one held BaseApp slot declaring 2 GiB and one unslotted BaseApp job: the old count rule
      // refuses a third BaseApp job; memory admits it (2 + 12 + 12 + 4 = 30).
      await hold(dir, 2, "baseapp");
      const pid = holders.at(-1);
      if (pid === undefined) throw new Error("no holder");
      writeFileSync(join(dir, "heavy.2"), `${pid}\n`);
      writeFileSync(join(dir, "heavy.2.class"), `baseapp ${pid} 2\n`);
      // the holder's ps row is the wrapper's, so both rules trust it as a BaseApp-class slot
      const one = psOf(
        `${pid} 1 ${pid} /bin/bash scripts/heavy-slot.sh --peak 2 baseapp sleep 30`,
        census(800),
      );
      expect(() => guardInSlot(1, true, () => {}, one)).not.toThrow();
      // (C) the same on a host with no cgroup limit: the count rule refuses
      process.env.LETHAL_HEAVY_CGROUP_DIR = join(dir, "no-cgroup");
      expect(() => guardInSlot(1, true, () => {}, one)).toThrow(RefusedError);
    } finally {
      for (const [k, v] of [
        ["LETHAL_HEAVY_LOCK_DIR", old.lock],
        ["LETHAL_HEAVY_CGROUP_DIR", old.cg],
      ] as const)
        if (v === undefined) Reflect.deleteProperty(process.env, k);
        else process.env[k] = v;
    }
  });

  test("guardInSlot applies the memory rule too", () => {
    const dir = fresh();
    const cg = fresh();
    writeFileSync(join(cg, "memory.current"), `${20 * GIB}\n`);
    writeFileSync(join(cg, "memory.max"), `${32 * GIB}\n`);
    const old = {
      lock: process.env.LETHAL_HEAVY_LOCK_DIR,
      cg: process.env.LETHAL_HEAVY_CGROUP_DIR,
    };
    process.env.LETHAL_HEAVY_LOCK_DIR = dir;
    process.env.LETHAL_HEAVY_CGROUP_DIR = cg;
    try {
      const ps = () => "PID PPID PGID COMMAND\n1 0 1 init";
      // baseapp's peak 12: 20 + 12 + 4 = 36 > 32
      expect(() => guardInSlot(1, true, () => {}, ps)).toThrow(RefusedError);
      writeFileSync(join(cg, "memory.current"), `${10 * GIB}\n`);
      expect(() => guardInSlot(1, true, () => {}, ps)).not.toThrow();
    } finally {
      for (const [k, v] of [
        ["LETHAL_HEAVY_LOCK_DIR", old.lock],
        ["LETHAL_HEAVY_CGROUP_DIR", old.cg],
      ] as const)
        if (v === undefined) Reflect.deleteProperty(process.env, k);
        else process.env[k] = v;
    }
  });
});
