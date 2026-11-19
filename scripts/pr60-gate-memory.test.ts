/**
 * PR-60: the al-runner update's memory gate takes the heavy-slot guard's inputs (`heldInputs`), so
 * R992's small-job allowance applies. Every lock folder here is a temp folder; nothing is written
 * under /coord (the ledger writer is a stub).
 */
import { afterEach, test as bunTest, describe, expect } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateMemoryVerdict } from "./al-runner-v3-update";
import { slotHeld } from "./corpus-snapshot";
import { RSS_FRESH_MS, slotRssFile } from "./heavy-slot-class";
import { heldInputs } from "./heavy-slot-guard";

// Real flock holders need Linux's flock(1); the Windows CI job has none (as heavy-slot-class.test.ts).
const test = process.platform === "win32" ? bunTest.skip : bunTest;

const GIB = 2 ** 30;
const sample = (usedGiB: number) => ({
  usedBytes: usedGiB * GIB,
  maxBytes: 32 * GIB,
  source: "test",
});
const PS_HEAD = "PID PPID PGID COMMAND\n1 0 1 init\n";

const dirs: string[] = [];
const holders: ReturnType<typeof Bun.spawn>[] = [];
afterEach(() => {
  for (const h of holders.splice(0)) h.kill();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Hold slot `n` with a real flock; `classText` is the class file ("" writes none). */
async function hold(dir: string, n: number, classText: string): Promise<void> {
  const lock = join(dir, `heavy.${n}`);
  holders.push(Bun.spawn(["flock", lock, "sleep", "30"], { stdout: "ignore", stderr: "ignore" }));
  for (let i = 0; i < 100 && !slotHeld(dir, n); i++) await Bun.sleep(20);
  expect(slotHeld(dir, n)).toBe(true);
  writeFileSync(lock, `${process.pid}\n`);
  if (classText !== "") writeFileSync(`${lock}.class`, classText);
}

const mk = () => {
  const d = mkdtempSync(join(tmpdir(), "pr60-"));
  dirs.push(d);
  return d;
};

function run(dir: string, usedGiB: number, ps = PS_HEAD) {
  const ledger: string[] = [];
  const v = gateMemoryVerdict(dir, {
    readSample: () => sample(usedGiB),
    psText: () => ps,
    appendLedger: (_d, who) => {
      ledger.push(who);
    },
  });
  return { v, ledger };
}

describe("PR-60 gateMemoryVerdict", () => {
  test("allowance applied: used + peak + reserve fits, fewer than 2 small held; ledger names the update", async () => {
    const dir = mk();
    await hold(dir, 1, `other ${process.pid} 12\n`);
    await hold(dir, 2, `other ${process.pid} 8\n`);
    await hold(dir, 3, `other ${process.pid} 8\n`);
    const { v, ledger } = run(dir, 8.2);
    expect(v?.refuse).toBe(false);
    expect(v?.message).toContain("small job");
    expect(ledger).toEqual(["al-runner-v3-update"]);
  });

  test("not applied with 2 small jobs held", async () => {
    const dir = mk();
    await hold(dir, 1, `other ${process.pid} 12 small\n`);
    await hold(dir, 2, `other ${process.pid} 8 small\n`);
    await hold(dir, 3, `other ${process.pid} 8\n`);
    const { v, ledger } = run(dir, 8.2);
    expect(v?.refuse).toBe(true);
    expect(ledger).toEqual([]);
  });

  test("fails closed when a held slot's class is unreadable", async () => {
    const dir = mk();
    await hold(dir, 1, `other ${process.pid} 12\n`);
    await hold(dir, 2, `other ${process.pid} 8\n`);
    await hold(dir, 3, ""); // no class file: counts at 12 and clears the allowance
    const { v, ledger } = run(dir, 8.2);
    expect(v?.refuse).toBe(true);
    expect(ledger).toEqual([]);
    expect(heldInputs(dir, process.pid, PS_HEAD).smallHeld).toBeUndefined();
  });

  test("the ps text reaches heldInputs: an unslotted BaseApp job's default peak (12) is in the held sum", async () => {
    const dir = mk();
    await hold(dir, 1, `other ${process.pid} 8\n`);
    const ps = `${PS_HEAD}200 1 200 bun scripts/corpus-snapshot.ts snapshot --root /work/src/BC.History/BaseApp\n`;
    expect(heldInputs(dir, process.pid, PS_HEAD).heldPeaks).toEqual([8]);
    expect(heldInputs(dir, process.pid, ps).heldPeaks).toEqual([8, 12]);
    expect(run(dir, 3, ps).v?.message).toContain("held slots' peaks 20.0 (2)");
  });

  test("the unslotted 12 GiB job flips an admission to a refusal", async () => {
    const dir = mk();
    await hold(dir, 1, `other ${process.pid} 8 small\n`);
    await hold(dir, 2, `other ${process.pid} 8 small\n`);
    const ps = `${PS_HEAD}200 1 200 bun scripts/corpus-snapshot.ts snapshot --root /work/src/BC.History/BaseApp\n`;
    // 16 + 2 + 4 = 22 fits; with the unslotted 12, 28 + 6 = 34 > 32 and 2 small are held: no allowance.
    expect(run(dir, 3).v?.message).toContain("admitted");
    expect(run(dir, 3).v?.refuse).toBe(false);
    expect(run(dir, 3, ps).v?.refuse).toBe(true);
    expect(run(dir, 3, ps).v?.message).toContain("REFUSED");
  });

  test("PR-226 S4: a private gate inside its own heavy slot does not count that slot, nor its own process tree, and appends no small-admit row", async () => {
    const dir = mk();
    await hold(dir, 1, `other ${process.pid} 8\n`); // the gate's own slot
    await hold(dir, 2, `other ${process.pid} 8\n`); // someone else's
    // The slot file names the wrapper (pid 900); this process runs under it.
    writeFileSync(join(dir, "heavy.1"), "900\n");
    writeFileSync(join(dir, "heavy.2"), "902\n"); // another job's wrapper, not above this process
    const ps = `${PS_HEAD}900 1 900 scripts/heavy-slot.sh --peak gate bun scripts/al-runner-v3-update.ts --root /x --local-candidate /y\n${process.pid} 900 900 bun scripts/al-runner-v3-update.ts --root /x --local-candidate /y\n901 ${process.pid} 900 bun run itest:alrunner-v3\n`;
    const ledger: string[] = [];
    const seams = {
      readSample: () => sample(8.2),
      psText: () => ps,
      appendLedger: (_d: string, who: string) => {
        ledger.push(who);
      },
    };
    const own = gateMemoryVerdict(dir, seams, { ownSlot: true });
    expect(own?.message).toContain("held slots' peaks 8.0 (1)");
    expect(ledger).toEqual([]);
    const all = gateMemoryVerdict(dir, seams);
    expect(all?.message).not.toContain("held slots' peaks 8.0 (1)");
    // Not inside any slot (no held slot's wrapper is above this process): nothing is excluded.
    const outside = gateMemoryVerdict(dir, { ...seams, psText: () => PS_HEAD }, { ownSlot: true });
    expect(outside?.message).not.toContain("held slots' peaks 8.0 (1)");
  });

  test("no cgroup limit: undefined", () => {
    const v = gateMemoryVerdict(mk(), {
      readSample: () => undefined,
      psText: () => PS_HEAD,
      appendLedger: () => {},
    });
    expect(v).toBeUndefined();
  });
});

describe("PR-179 heldInputs counts a held slot at max(fresh RSS, 0.8 x declared)", () => {
  test("fresh reading below 0.8 x declared, above it, stale, and missing", async () => {
    const dir = mk();
    for (const n of [1, 2, 3, 4]) await hold(dir, n, `other ${process.pid} 10\n`);
    writeFileSync(slotRssFile(dir, 1), `${2 * 2 ** 20}\n`); // 2 GiB: counts 8
    writeFileSync(slotRssFile(dir, 2), `${9 * 2 ** 20}\n`); // 9 GiB: counts 9
    writeFileSync(slotRssFile(dir, 3), `${2 * 2 ** 20}\n`); // stale: counts 10
    const old = new Date(Date.now() - RSS_FRESH_MS - 5000);
    utimesSync(slotRssFile(dir, 3), old, old);
    // slot 4: no reading: counts 10
    expect(heldInputs(dir, process.pid, PS_HEAD).heldPeaks).toEqual([8, 9, 10, 10]);
  });
});
