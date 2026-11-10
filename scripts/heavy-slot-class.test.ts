import { afterAll, test as bunTest, describe, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardInSlot, heavyVerdict, parsePs } from "./corpus-snapshot.ts";
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

describe("R905 scripts/heavy-slot.sh", () => {
  test("writes the class while the command runs, removes it after, keeps the exit code", () => {
    const dir = fresh();
    const script = join(import.meta.dir, "heavy-slot.sh");
    const run = (cls: string, ...cmd: string[]) =>
      Bun.spawnSync(["bash", script, cls, ...cmd], {
        env: { ...process.env, LETHAL_HEAVY_LOCK_DIR: dir },
      });
    const r = run("other", "sh", "-c", `cat "${dir}/heavy.1.class"; exit 7`);
    expect(r.stdout.toString()).toMatch(/^other \d+\n$/);
    expect(r.exitCode).toBe(7);
    expect(existsSync(join(dir, "heavy.1.class"))).toBe(false);
    expect(run("bogus", "true").exitCode).toBe(2);
  });
});
