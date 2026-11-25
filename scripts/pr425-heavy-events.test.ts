// PR-425 (R1211): heavy-slot's events ledger (EVENTS_LEDGER, heavy-events.tsv): the guard writes one line per verdict with
// the readings it compared, and heavy-slot.sh writes a `queue` line when a --wait ticket is taken. Admission-neutral: the
// same inputs give the same exit code whether or not the ledger can be written. Every lock folder and cgroup here is a temp
// folder: nothing touches /coord.
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVENTS_LEDGER, eventLine } from "./heavy-slot-class.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), "pr425-"));
  dirs.push(d);
  return d;
};
const GIB = 2 ** 30;
/** A fake cgroup folder (used and max in GiB), and an empty ps seam. */
const setup = (usedGiB: number, maxGiB = 32) => {
  const dir = fresh();
  const cg = join(dir, "cgroup");
  mkdirSync(cg);
  writeFileSync(join(cg, "memory.current"), `${usedGiB * GIB}\n`);
  writeFileSync(join(cg, "memory.max"), `${maxGiB * GIB}\n`);
  const ps = join(dir, "ps.txt");
  writeFileSync(ps, "PID PPID PGID COMMAND\n1 0 1 init\n");
  const peakPs = join(dir, "peak-ps.txt");
  writeFileSync(peakPs, "");
  return { dir, cg, ps, peakPs };
};
const env = (s: ReturnType<typeof setup>) => ({
  ...process.env,
  LETHAL_HEAVY_LOCK_DIR: s.dir,
  BUN: process.execPath,
  LETHAL_HEAVY_PS_FILE: s.ps,
  LETHAL_HEAVY_PEAK_PS_FILE: s.peakPs,
  LETHAL_HEAVY_POLL_S: "0.05",
  LETHAL_HEAVY_CGROUP_DIR: s.cg,
});
/** The guard alone, for slot 1 (whose lock file names pid 4242), as heavy-slot.sh calls it. */
const guard = (s: ReturnType<typeof setup>, peak: string) => {
  writeFileSync(join(s.dir, "heavy.1"), "4242\n");
  return Bun.spawnSync(
    [process.execPath, join(import.meta.dir, "heavy-slot-guard.ts"), s.dir, "1", "other", peak],
    { env: env(s), stdout: "pipe", stderr: "pipe" },
  );
};
const events = (dir: string) =>
  existsSync(join(dir, EVENTS_LEDGER))
    ? readFileSync(join(dir, EVENTS_LEDGER), "utf8")
        .trim()
        .split("\n")
        .map((l) => l.split("\t"))
    : [];

describe("PR-425: the guard's events", () => {
  // Red: drop logEvent's call for the memory verdict.
  test("an admission: one `admit` line with the readings it compared", () => {
    const s = setup(3);
    const g = guard(s, "2");
    expect(g.exitCode).toBe(0);
    const e = events(s.dir);
    expect(e).toHaveLength(1);
    // event, who, class, peak, pid, used, used + peak + reserve, held, held + peak + reserve, max
    expect(e[0]?.slice(1)).toEqual([
      "admit",
      "heavy.1",
      "other",
      "2",
      "4242",
      "3.00",
      "9.00",
      "0.00",
      "6.00",
      "32.00",
    ]);
  });

  test("a refusal: one `refuse` line, and its used + peak + reserve is over max", () => {
    const s = setup(28);
    const g = guard(s, "2");
    expect(g.exitCode).toBe(75);
    expect(events(s.dir)[0]?.slice(1, 8)).toEqual([
      "refuse",
      "heavy.1",
      "other",
      "2",
      "4242",
      "28.00",
      "34.00",
    ]);
  });

  test("a job that can never fit: one `never` line, exit 2", () => {
    const s = setup(3);
    const g = guard(s, "40");
    expect(g.exitCode).toBe(2);
    expect(events(s.dir)[0]?.[1]).toBe("never");
  });

  // Red: remove logEvent's try/catch (the throw ends the guard with another exit code).
  test.each([
    ["an admission", 3, 0],
    ["a refusal", 28, 75],
  ])(
    "admission-neutral: %s gives the same exit code when the ledger cannot be written",
    (_n, used, rc) => {
      const ok = setup(used);
      const broken = setup(used);
      mkdirSync(join(broken.dir, EVENTS_LEDGER)); // a folder where the ledger file would go: every append throws
      const a = guard(ok, "2");
      const b = guard(broken, "2");
      expect([a.exitCode, b.exitCode]).toEqual([rc, rc]);
      expect(b.stderr.toString()).toContain("the events ledger was not written");
      expect(events(ok.dir)).toHaveLength(1);
    },
  );
});

describe("PR-425: heavy-slot.sh's queue event", () => {
  // Red: drop the queue printf in heavy-slot.sh.
  test("a --wait job writes `queue` (ticket) and then `admit` (slot), both with its own pid", async () => {
    const s = setup(3);
    const ran = join(s.dir, "ran");
    const p = Bun.spawn(
      [
        "bash",
        join(import.meta.dir, "heavy-slot.sh"),
        "--wait",
        "--peak",
        "2",
        "other",
        "touch",
        ran,
      ],
      { env: env(s), stdout: "ignore", stderr: "ignore" },
    );
    expect(await p.exited).toBe(0);
    expect(existsSync(ran)).toBe(true);
    const e = events(s.dir);
    expect(e.map((l) => l[1])).toEqual(["queue", "admit"]);
    expect(e[0]?.slice(2, 6)).toEqual(["ticket 1", "other", "2", String(p.pid)]);
    expect(e[0]?.slice(6)).toEqual(["-", "-", "-", "-", "-"]);
    expect(e[1]?.[5]).toBe(String(p.pid));
  });

  test("a queue event that cannot be written does not stop the job", async () => {
    const s = setup(3);
    mkdirSync(join(s.dir, EVENTS_LEDGER));
    const ran = join(s.dir, "ran");
    const p = Bun.spawn(
      [
        "bash",
        join(import.meta.dir, "heavy-slot.sh"),
        "--wait",
        "--peak",
        "2",
        "other",
        "touch",
        ran,
      ],
      { env: env(s), stdout: "ignore", stderr: "ignore" },
    );
    expect(await p.exited).toBe(0);
    expect(existsSync(ran)).toBe(true);
  });
});

test("eventLine: a missing reading is `-`", () => {
  expect(
    eventLine(new Date(0), "count-admit", "heavy.2", "baseapp", 12, "7", undefined, undefined, 4),
  ).toBe("1970-01-01T00:00:00.000Z\tcount-admit\theavy.2\tbaseapp\t12\t7\t-\t-\t-\t-\t-\n");
});
