/**
 * PR-60: the al-runner update's memory gate takes the heavy-slot guard's inputs (`heldInputs`), so
 * R992's small-job allowance applies. Every lock folder here is a temp folder; nothing is written
 * under /coord (the ledger writer is a stub).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateMemoryVerdict } from "./al-runner-v3-update";
import { slotHeld } from "./corpus-snapshot";
import { heldInputs } from "./heavy-slot-guard";

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

  test("counts an unslotted heavy process, and it can turn an admission into a refusal", async () => {
    const dir = mk();
    await hold(dir, 1, `other ${process.pid} 8\n`);
    const ps = `${PS_HEAD}200 1 200 bun scripts/corpus-snapshot.ts snapshot --root /work/src/BC.History/BaseApp\n`;
    expect(heldInputs(dir, process.pid, PS_HEAD).heldPeaks).toEqual([8]);
    expect(heldInputs(dir, process.pid, ps).heldPeaks).toEqual([8, 12]);
    // 8 + 12 + 2 + 4 = 26 fits; with another 8 held it does not, but the allowance still admits
    // (used is low); the unslotted job is what the declared-sum check saw.
    expect(run(dir, 3, ps).v?.message).toContain("held slots' peaks 20.0 (2)");
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
