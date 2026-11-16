// R1077 (PR-72): heavy-slot's advisory on a declared --peak far above the ledger's measured peaks. Every file lives in a temp
// folder (the lock dir is LETHAL_HEAVY_LOCK_DIR), never under /coord.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIN_ROWS, advise, rowsOfShape, shapeOf } from "./heavy-slot-advice.ts";

const TMP = mkdtempSync(join(tmpdir(), "heavy-slot-advice-test-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const SCOPED =
  "bun packages/runner/src/cli.ts run --project /src/do --tests /src/do-test --backend al-runner-v3";
const WINDOW =
  "timeout --foreground -k 900 15300 bun packages/runner/src/cli.ts run --project /src/do --tests /src/do-test";

/** A heavy-peaks.tsv line: start, end, slot, class, declared, measured, rc, class file, command. */
const row = (started: string, cls: string, declared: number, measured: string, cmd: string) =>
  [
    started,
    started,
    "heavy.1",
    cls,
    String(declared),
    measured,
    "0",
    `${cls} 1 ${declared}`,
    cmd,
  ].join("\t");
const ledger = (...lines: string[]) => `${lines.join("\n")}\n`;
const threeScoped = (measured: [string, string, string]) =>
  ledger(...measured.map((m, i) => row(`2026-11-16T05:0${i}:00Z`, "baseapp", 12, m, SCOPED)));

describe("shapeOf", () => {
  test("class, wrapper names, program and --project; wrapper arguments are left out", () => {
    expect(shapeOf("baseapp", SCOPED)).toBe("baseapp | bun packages/runner/src/cli.ts | /src/do");
    expect(shapeOf("baseapp", WINDOW)).toBe(
      "baseapp | timeout > bun packages/runner/src/cli.ts | /src/do",
    );
    expect(shapeOf("baseapp", `timeout -k 120 5400 ${SCOPED}`)).toBe(
      shapeOf("baseapp", WINDOW.replace("--foreground -k 900", "-k 1")),
    );
    expect(
      shapeOf("baseapp", `/usr/bin/time -v -o /x/t.txt timeout --foreground -k 9 99 ${SCOPED}`),
    ).toBe("baseapp | time > timeout > bun packages/runner/src/cli.ts | /src/do");
    expect(shapeOf("other", "bun run itest:alrunner-v3")).toBe(
      "other | bun run itest:alrunner-v3 | ",
    );
    expect(
      shapeOf("other", "/work/tools/al-runner-v3/current/al-runner test --bc-version 28 /x"),
    ).toBe("other | al-runner | ");
  });
  test("a different --project or class is a different shape", () => {
    expect(shapeOf("baseapp", SCOPED)).not.toBe(
      shapeOf("baseapp", SCOPED.replace("/src/do ", "/src/dc ")),
    );
    expect(shapeOf("baseapp", SCOPED)).not.toBe(shapeOf("other", SCOPED));
  });
});

describe("advise", () => {
  test(`fires when declared > 2x the largest measured peak of >= ${MIN_ROWS} rows of the shape (PR-67's case)`, () => {
    const line = advise(threeScoped(["3.49", "3.90", "3.32"]), "baseapp", 12, SCOPED);
    expect(line).toBeDefined();
    expect(line).toContain("--peak 12 GiB");
    expect(line).toContain("(3.90 GiB) of 3 earlier job(s)");
    expect(line).toContain("2026-11-16T05:00:00Z to 2026-11-16T05:02:00Z");
    expect(line).toContain("about 6 GiB");
    expect(line).toContain("Admission is unchanged.");
  });
  test("silent at exactly 2x and below (the boundary is strict)", () => {
    expect(advise(threeScoped(["3.00", "6.00", "3.00"]), "baseapp", 12, SCOPED)).toBeUndefined();
    expect(advise(threeScoped(["3.00", "5.00", "3.00"]), "baseapp", 9, SCOPED)).toBeUndefined();
    expect(advise(threeScoped(["3.00", "5.99", "3.00"]), "baseapp", 12, SCOPED)).toBeDefined();
  });
  test(`silent with fewer than ${MIN_ROWS} rows of the shape`, () => {
    const two = ledger(
      row("2026-11-16T05:00:00Z", "baseapp", 12, "1.00", SCOPED),
      row("2026-11-16T05:01:00Z", "baseapp", 12, "1.00", SCOPED),
    );
    expect(advise(two, "baseapp", 12, SCOPED)).toBeUndefined();
  });
  test("rows of another shape do not count: a full window's high peak does not hide a scoped run's", () => {
    const mixed = ledger(
      ...[0, 1, 2].map((i) => row(`2026-11-16T05:0${i}:00Z`, "baseapp", 12, "3.50", SCOPED)),
      row("2026-11-16T06:00:00Z", "baseapp", 12, "10.51", WINDOW),
    );
    expect(advise(mixed, "baseapp", 12, SCOPED)).toBeDefined();
    expect(advise(mixed, "baseapp", 12, WINDOW)).toBeUndefined(); // one row of the window's shape
  });
  test("a row with no sample (`?`) or a short line is left out", () => {
    const rows = rowsOfShape(
      ledger(
        row("2026-11-16T05:00:00Z", "baseapp", 12, "?", SCOPED),
        "too\tshort",
        row("2026-11-16T05:01:00Z", "baseapp", 12, "2.00", SCOPED),
      ),
      "baseapp",
      SCOPED,
    );
    expect(rows).toEqual([{ started: "2026-11-16T05:01:00Z", measuredGiB: 2 }]);
  });
});

describe("review r1 fixes", () => {
  test("`env VAR=x` is a wrapper, so unlike programs behind it do not merge", () => {
    expect(shapeOf("other", "env A=1 B=2 bun scripts/verify.ts")).toBe(
      "other | env > bun scripts/verify.ts | ",
    );
    expect(shapeOf("other", "env HOME=/x /t/al-runner test /y")).toBe("other | env > al-runner | ");
    expect(shapeOf("other", "env A=1 bun scripts/verify.ts")).not.toBe(
      shapeOf("other", "env A=1 /t/al-runner test"),
    );
  });
  test("`bash -c <cmd>` keeps the command's first word", () => {
    expect(shapeOf("other", "timeout 16200 bash -c run")).toBe("other | timeout > bash -c run | ");
    expect(shapeOf("other", "bash -c bash /x/dry.sh")).toBe("other | bash -c bash | ");
    expect(shapeOf("other", "bash /coord/handoff/R-984/run.sh 9")).toBe(
      "other | bash /coord/handoff/R-984/run.sh | ",
    );
  });
  test("a worktree's absolute script path has the same shape as the repo-relative one", () => {
    expect(
      shapeOf(
        "baseapp",
        "bun /work/lethal-wt/r-984/packages/runner/src/cli.ts run --project /src/do",
      ),
    ).toBe(shapeOf("baseapp", "bun packages/runner/src/cli.ts run --project /src/do"));
    expect(shapeOf("other", "bun /work/lethal-wt/pr-72/scripts/verify.ts")).toBe(
      shapeOf("other", "bun scripts/verify.ts"),
    );
  });
  test("a failed start (non-zero exit within 60 s) is no evidence; a long non-zero run is", () => {
    const at = (start: string, end: string, rc: string, measured: string) =>
      [start, end, "heavy.1", "baseapp", "12", measured, rc, "baseapp 1 12", SCOPED].join("\t");
    const rows = rowsOfShape(
      ledger(
        at("2026-11-16T05:00:00Z", "2026-11-16T05:00:05Z", "1", "0.05"), // died at start: left out
        at("2026-11-16T05:01:00Z", "2026-11-16T05:01:30Z", "0", "0.40"), // short but clean: kept
        at("2026-11-16T05:02:00Z", "2026-11-16T08:32:00Z", "7", "9.31"), // a window at its budget: kept
        at("2026-11-16T05:03:00Z", "2026-11-16T05:03:59Z", "127", "0.01"), // died at start: left out
      ),
      "baseapp",
      SCOPED,
    );
    expect(rows.map((r) => r.measuredGiB)).toEqual([0.4, 9.31]);
  });
});

describe("heavy-slot.sh prints it and still admits the job", () => {
  const script = join(import.meta.dir, "heavy-slot.sh");
  const GIB = 1024 ** 3;
  const run = (dir: string, ...args: string[]) => runWith(dir, process.execPath, ...args);
  const runWith = (dir: string, bun: string, ...args: string[]) => {
    const cg = mkdtempSync(join(TMP, "cg-"));
    writeFileSync(join(cg, "memory.current"), `${3 * GIB}\n`);
    writeFileSync(join(cg, "memory.max"), `${32 * GIB}\n`);
    writeFileSync(join(cg, "memory.stat"), "inactive_file 0\n");
    const psFile = join(dir, "ps.txt");
    writeFileSync(psFile, "PID PPID PGID COMMAND\n1 0 1 init\n");
    const peakPs = join(dir, "peak-ps.txt");
    writeFileSync(peakPs, "");
    return Bun.spawnSync(["bash", script, ...args], {
      env: {
        ...process.env,
        LETHAL_HEAVY_LOCK_DIR: dir,
        BUN: bun,
        LETHAL_HEAVY_PS_FILE: psFile,
        LETHAL_HEAVY_PEAK_PS_FILE: peakPs,
        LETHAL_HEAVY_CGROUP_DIR: cg,
      },
    });
  };
  const SHAPE = ["true", "--project", "/src/x"];
  const seeded = (measured: string) => {
    const dir = mkdtempSync(join(TMP, "locks-"));
    writeFileSync(
      join(dir, "heavy-peaks.tsv"),
      ledger(
        ...[0, 1, 2].map((i) =>
          row(`2026-11-16T05:0${i}:00Z`, "other", 6, measured, SHAPE.join(" ")),
        ),
      ),
    );
    return dir;
  };
  test("declared 6 against measured 1.00: the advisory line, and the job runs (exit 0)", () => {
    const r = run(seeded("1.00"), "--peak", "6", "other", ...SHAPE);
    expect(r.exitCode).toBe(0);
    expect(r.stderr.toString()).toContain("heavy-slot: advisory (R1077): --peak 6 GiB");
  });
  test("declared 6 against measured 3.00 (exactly 2x): no advisory line, and the job runs", () => {
    const r = run(seeded("3.00"), "--peak", "6", "other", ...SHAPE);
    expect(r.exitCode).toBe(0);
    expect(r.stderr.toString()).not.toContain("advisory (R1077)");
  });
  test("review r1: the helper never carries the job's command in its own argv (the guard's ps scan would count it)", () => {
    const dir = seeded("1.00");
    const log = join(dir, "bun-argv.log");
    const wrapper = join(dir, "bun-wrapper.sh");
    // records every bun call's arguments, then runs the real bun
    writeFileSync(
      wrapper,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${process.execPath}' "$@"\n`,
      { mode: 0o755 },
    );
    const marker = "/work/src/DO/marker-path";
    const r = runWith(dir, wrapper, "--peak", "6", "other", "true", "--project", "/src/x", marker);
    expect(r.exitCode).toBe(0);
    const calls = readFileSync(log, "utf8").trim().split("\n");
    const advice = calls.filter((c) => c.includes("heavy-slot-advice.ts"));
    expect(advice).toHaveLength(1);
    expect(advice[0]).not.toContain(marker);
    expect(advice[0]).not.toContain("--project");
  });
});
