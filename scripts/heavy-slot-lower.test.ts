// PR-73: lowering a running job's declared peak. Every file is in a temp folder (LETHAL_HEAVY_LOCK_DIR), never /coord.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MARGIN_GIB, floorGiB, parseSlotLine, refusal } from "./heavy-slot-lower.ts";

const TMP = mkdtempSync(join(tmpdir(), "heavy-slot-lower-test-"));
const holders: ReturnType<typeof Bun.spawn>[] = [];
afterAll(() => {
  for (const h of holders) h.kill();
  rmSync(TMP, { recursive: true, force: true });
});

describe("the rules", () => {
  const line = { cls: "other", pid: 42, peakGiB: 8, small: false };
  test("a lower peak above the measured floor is accepted", () => {
    expect(refusal(line, 42, 3, 1.3)).toBeUndefined();
  });
  test("raising, or an equal value, is refused", () => {
    expect(refusal(line, 42, 9, 1.3)).toContain("can only be lowered");
    expect(refusal(line, 42, 8, 1.3)).toContain("can only be lowered");
  });
  test("a value under the measured tree plus its margin is refused", () => {
    expect(refusal(line, 42, 2, 1.3)).toContain("under the measured tree"); // floor 2.3
    expect(refusal(line, 42, 7, 6)).toContain("under the measured tree"); // floor 7.5 (25% of 6)
    expect(refusal(line, 42, 7.5, 6)).toBeUndefined();
  });
  test("another pid's slot is refused", () => {
    expect(refusal(line, 43, 3, 1.3)).toContain("held by pid 42");
  });
  test("the margin is the larger of 1 GiB and 25%", () => {
    expect(floorGiB(1)).toBe(1 + MARGIN_GIB);
    expect(floorGiB(8)).toBe(10);
  });
  test("parseSlotLine keeps the small mark and refuses a line with no explicit peak", () => {
    expect(parseSlotLine("other 7 8 small\n")).toEqual({
      cls: "other",
      pid: 7,
      peakGiB: 8,
      small: true,
    });
    expect(parseSlotLine("baseapp 7\n")).toBeUndefined();
  });
});

describe.skipIf(process.platform === "win32")("heavy-slot-lower.ts on a held slot", () => {
  const script = join(import.meta.dir, "heavy-slot-lower.ts");
  /** A live holder whose command line names heavy-slot.sh, as a real slot's holder does. */
  const holder = (dir: string): number => {
    const sh = join(dir, "heavy-slot.sh");
    writeFileSync(sh, "sleep 60\n");
    const p = Bun.spawn(["bash", sh]);
    holders.push(p);
    return p.pid;
  };
  /** A lock dir holding slot 1 for `pid` at `declared` GiB; `measuredKb` in the sampler's peak file and in the ps seam. */
  const held = (declared: number, measuredKb: number, mark = "") => {
    const dir = mkdtempSync(join(TMP, "locks-"));
    const pid = holder(dir);
    writeFileSync(join(dir, "heavy.1"), `${pid}\n`); // heavy-slot.sh's own pid in the slot's lock file
    writeFileSync(join(dir, "heavy.1.class"), `other ${pid} ${declared}${mark}\n`);
    writeFileSync(join(dir, "heavy.1.peak"), `${measuredKb}\n`);
    writeFileSync(join(dir, "ps.txt"), `${pid} 1 ${measuredKb}\n`);
    return { dir, pid };
  };
  const lower = (dir: string, pid: number, gib: number) =>
    Bun.spawnSync([process.execPath, script, "1", String(pid), String(gib)], {
      env: {
        ...process.env,
        LETHAL_HEAVY_LOCK_DIR: dir,
        LETHAL_HEAVY_PEAK_PS_FILE: join(dir, "ps.txt"),
      },
    });
  const GIB_KB = 1024 * 1024;

  test("lower accepted: 8 -> 3 GiB at 1.3 GiB measured; the class and the small mark are kept", () => {
    const { dir, pid } = held(8, 1.3 * GIB_KB, " small");
    const r = lower(dir, pid, 3);
    expect(r.exitCode).toBe(0);
    expect(readFileSync(join(dir, "heavy.1.class"), "utf8")).toBe(`other ${pid} 3 small\n`);
  });
  test("raise refused: the file is unchanged", () => {
    const { dir, pid } = held(8, 1.3 * GIB_KB);
    const r = lower(dir, pid, 10);
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("can only be lowered");
    expect(readFileSync(join(dir, "heavy.1.class"), "utf8")).toBe(`other ${pid} 8\n`);
  });
  test("under-measured refused: 2 GiB against 1.3 GiB measured (floor 2.3); the file is unchanged", () => {
    const { dir, pid } = held(8, 1.3 * GIB_KB);
    const r = lower(dir, pid, 2);
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("under the measured tree");
    expect(readFileSync(join(dir, "heavy.1.class"), "utf8")).toBe(`other ${pid} 8\n`);
  });
  test("the sampler's peak so far counts even when the tree is small now", () => {
    const { dir, pid } = held(8, 6 * GIB_KB);
    writeFileSync(join(dir, "ps.txt"), `${pid} 1 ${0.5 * GIB_KB}\n`); // the tree shrank since its peak
    expect(lower(dir, pid, 4).exitCode).toBe(1); // floor 7.5 from the 6 GiB peak
    expect(lower(dir, pid, 7.5).exitCode).toBe(0);
  });
  test("a pid that is not the slot's holder, or not a heavy-slot.sh, is refused", () => {
    const { dir, pid } = held(8, 1 * GIB_KB);
    expect(lower(dir, pid + 100000, 3).exitCode).toBe(1);
    const notHolder = Bun.spawn(["sleep", "60"]);
    holders.push(notHolder);
    writeFileSync(join(dir, "heavy.1.class"), `other ${notHolder.pid} 8\n`);
    const r = lower(dir, notHolder.pid, 3);
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("not a live heavy-slot.sh");
  });
  test("review r1: another LIVE heavy-slot.sh than the slot's holder is refused (class file and lock file)", () => {
    const { dir, pid } = held(8, 1 * GIB_KB);
    const other = holder(mkdtempSync(join(TMP, "other-")));
    const r = lower(dir, other, 3); // a live heavy-slot.sh, but not this slot's
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toMatch(/heavy\.1 names pid \d+, not \d+|held by pid/);
    writeFileSync(join(dir, "heavy.1"), `${other}\n`); // the lock file names someone else: refused though the class matches
    const r2 = lower(dir, pid, 3);
    expect(r2.exitCode).toBe(1);
    expect(r2.stderr.toString()).toContain(`heavy.1 names pid ${other}, not ${pid}`);
    expect(readFileSync(join(dir, "heavy.1.class"), "utf8")).toBe(`other ${pid} 8\n`);
  });
  test("review r1: the tree now counts when it is above the sampler's peak (a fresh job, peak file still 0)", () => {
    const { dir, pid } = held(8, 0);
    writeFileSync(join(dir, "ps.txt"), `${pid} 1 ${6 * GIB_KB}\n`);
    expect(lower(dir, pid, 4).exitCode).toBe(1); // floor 7.5 from the 6 GiB tree
    expect(lower(dir, pid, 7.5).exitCode).toBe(0);
  });
  test("review r1: it waits for the guard's lock (no admission decides mid-lowering)", () => {
    const { dir, pid } = held(8, 1 * GIB_KB);
    const ready = join(dir, "lock-held");
    // a process holding heavy-guard.lock until killed, as a guard admission would
    const blocker = Bun.spawn([
      "flock",
      join(dir, "heavy-guard.lock"),
      "sh",
      "-c",
      `touch '${ready}'; sleep 30`,
    ]);
    holders.push(blocker);
    for (let i = 0; i < 200 && !existsSync(ready); i++) Bun.sleepSync(10);
    const r = Bun.spawnSync(["timeout", "2", process.execPath, script, "1", String(pid), "3"], {
      env: {
        ...process.env,
        LETHAL_HEAVY_LOCK_DIR: dir,
        LETHAL_HEAVY_PEAK_PS_FILE: join(dir, "ps.txt"),
      },
    });
    expect(r.exitCode).toBe(124); // still waiting for the lock when timeout ended it
    expect(readFileSync(join(dir, "heavy.1.class"), "utf8")).toBe(`other ${pid} 8\n`);
    blocker.kill();
  });
  test("no such slot: exit 2", () => {
    const dir = mkdtempSync(join(TMP, "empty-"));
    expect(lower(dir, 1, 3).exitCode).toBe(2);
  });
});
