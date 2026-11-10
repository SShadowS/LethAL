import { afterAll, test as bunTest, describe, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RefusedError, guardInSlot, heavyVerdict, parsePs, slotHeld } from "./corpus-snapshot.ts";
import { readSlotClass } from "./heavy-slot-class.ts";

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
    const onBaseApp = heavyVerdict(ps("/work/src/BC.History/BaseApp"), 100, [], 1, false, [
      "other",
    ]);
    expect(onBaseApp.foreign.length).toBe(1);
    expect(onBaseApp.refuse).toBe(true);
    const elsewhere = heavyVerdict(ps("/work/src/DO"), 100, [], 1, false, ["other"]);
    expect(elsewhere.foreign.length).toBe(1);
    expect(elsewhere.refuse).toBe(false);
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
      expect(readFileSync(join(dir, "heavy.1.class"), "utf8")).toBe(`baseapp ${process.pid}\n`);
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
    expect(r.stdout.toString()).toMatch(/^other (\d+)\n\1\n$/);
    expect(r.exitCode).toBe(7);
    expect(existsSync(join(dir, "heavy.1.class"))).toBe(false);
    expect(run(dir, "bogus", "true").exitCode).toBe(2);
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
  test("all slots held: exit 75, and a busy slot's pid in the lock file survives", async () => {
    const dir = fresh();
    for (const n of [1, 2, 3]) writeFileSync(join(dir, `heavy.${n}`), "12345\n");
    for (const n of [1, 2, 3]) await hold(dir, n, "other");
    const r = run(dir, "other", "true");
    expect(r.exitCode).toBe(75);
    for (const n of [1, 2, 3])
      expect(readFileSync(join(dir, `heavy.${n}`), "utf8")).toBe("12345\n");
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
});
