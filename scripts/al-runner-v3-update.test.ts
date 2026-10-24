// R586 T19 (plan r2 §12, r3 F6, r4 I-3): the v3 update gate with fakes, every outcome both ways.
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { V3_GATE_LEGS } from "../packages/runner/itest/al-runner-v3-gate";
import { parseGated } from "../packages/runner/src/al-runner-v3-pin";
import {
  GATE_STEPS,
  HEAVY_JOB,
  type Outcome,
  type UpdateDeps,
  V3_CDO_DEFAULT,
  candidates,
  edgeOnce,
  edgeRejudge,
  expectedSha,
  gateOne,
  readReceipt,
  runToLog,
  updateExitCode,
  updateOnce,
} from "./al-runner-v3-update";

// R416's pattern: the update gate's install flow is Linux-only (a symlink for `current`, moved by
// rename; /proc for "in use"; /work/tools), so its T19 and edge-path tests run on Linux only (the
// unit-linux CI job). The receipt and worktree-preparation tests are pure and run everywhere.
const linuxOnly = process.platform === "win32" ? describe.skip : describe;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const GATED_COMMIT = "abcdef1234567abcdef1234567abcdef12345678";
const FIXED_COMMIT = "fedcba7654321fedcba7654321fedcba76543210";
const REGATE_COMMIT = "1234567abcdef1234567abcdef1234567abcdef1";

let root = "";
afterEach(async () => {
  if (root !== "") await rm(root, { recursive: true, force: true });
});

async function setup(commit = GATED_COMMIT): Promise<string> {
  if (root !== "") await rm(root, { recursive: true, force: true });
  root = await mkdtemp(join(tmpdir(), "lethal-r586-update-"));
  const cur = join(root, "3.0.0-alpha.2-91253f2d6");
  await mkdir(cur, { recursive: true });
  await writeFile(join(cur, "al-runner"), "alpha2");
  await writeFile(
    join(cur, ".gated"),
    JSON.stringify({
      version: "alrunner 3.0.0-alpha.2 (91253f2d6)",
      binarySha256: sha("alpha2"),
      lethalCommit: commit,
    }),
  );
  await symlink(cur, join(root, "current"));
  return root;
}

/** Legs that give `o` by gateOutcome over the exact leg set (M3). */
const legsFor = (o: Outcome): Record<string, string> =>
  Object.fromEntries(V3_GATE_LEGS.map((l, i) => [l, i === 0 ? o : "pass"]));

function fake(o: {
  outcome?: Outcome;
  badNonce?: boolean;
  badSha?: boolean;
  badSums?: boolean;
  inUse?: boolean;
  tags?: string[];
  legs?: Record<string, string>;
  receiptCommit?: string;
  receiptSha?: string;
  lines?: string[];
  warnFacts?: Record<string, string>;
  heavy?: number;
  free?: number;
  /** Written as `gate.log` beside the receipt, as `realDeps().runGate` does (R633 I1). */
  gateLog?: string;
  /** The gate throws this after writing its files (a non-zero exit). */
  throwText?: string;
  /** R639 I3: `/proc/<pid>/cmdline` by pid (absent: no such pid), and the orphan pids. */
  procs?: Record<number, string>;
  orphans?: number[];
  /** R639: `--version` of every binary (default: alpha.3's). */
  version?: string;
  /** R639 L6: runs inside the gate, before the receipt is written. */
  onGate?: () => Promise<void>;
  /** R614 I2: the gate's preparation line, sent through runGate's `log`. */
  prepLine?: string;
  /** R586d: the gate's outcome per candidate tag (falls back to `outcome`). */
  byTag?: Record<string, Outcome>;
}) {
  let lastTag = "";
  const seen = {
    tagsGated: [] as string[],
    gates: [] as string[],
    envs: [] as Readonly<Record<string, string>>[],
    extracts: 0,
    downloads: 0,
    logs: [] as string[],
  };
  const deps: UpdateDeps = {
    procCmdline: async (pid) => o.procs?.[pid],
    procsWithCwdUnder: async () => o.orphans ?? [],
    heavyJobs: async () => o.heavy ?? 0,
    freeGb: async () => o.free ?? 20,
    root,
    listReleases: async () =>
      o.tags ?? ["edge", "v3.0.0-alpha.3", "v3.0.0-alpha.2", "v3.0.0-alpha.1"],
    download: async (tag, dir) => {
      lastTag = tag;
      seen.downloads += 1;
      await writeFile(join(dir, "t.tar.xz"), "tarball");
      await writeFile(
        join(dir, "SHA256SUMS"),
        `${o.badSums === true ? "0".repeat(64) : sha("tarball")}  t.tar.xz\n`,
      );
      return { tarball: join(dir, "t.tar.xz"), sums: join(dir, "SHA256SUMS") };
    },
    extract: async (_t, dir) => {
      seen.extracts += 1;
      await writeFile(join(dir, "al-runner"), "alpha3");
      return join(dir, "al-runner");
    },
    versionOf: async () => o.version ?? "al-runner 3.0.0-alpha.3 (c893e3633)",
    runGate: async (commit, env, log) => {
      seen.tagsGated.push(lastTag);
      const outcome = o.byTag?.[lastTag] ?? o.outcome;
      seen.gates.push(commit);
      seen.envs.push(env);
      if (o.prepLine !== undefined) await log(o.prepLine);
      await o.onGate?.();
      const receiptPath = env.LETHAL_V3_GATE_RECEIPT ?? "";
      if (o.gateLog !== undefined)
        await writeFile(join(dirname(receiptPath), "gate.log"), o.gateLog);
      if (outcome === undefined) {
        if (o.throwText !== undefined) throw new Error(o.throwText);
        return;
      }
      await writeFile(
        env.LETHAL_V3_GATE_RECEIPT ?? "",
        JSON.stringify({
          nonce: o.badNonce === true ? "stale" : env.LETHAL_V3_GATE_NONCE,
          binarySha256: o.receiptSha ?? (o.badSha === true ? sha("other") : sha("alpha3")),
          lethalCommit: o.receiptCommit ?? commit,
          dirty: false,
          outcome,
          legs: o.legs ?? legsFor(outcome),
          lines: o.lines ?? [],
          ...(o.warnFacts !== undefined ? { warnFacts: o.warnFacts } : {}),
        }),
      );
      if (o.throwText !== undefined) throw new Error(o.throwText);
    },
    inUse: async () => o.inUse === true,
    log: async (l) => {
      seen.logs.push(l);
    },
    now: () => "2026-10-21T00:00:00Z",
  };
  return { deps, seen };
}

const current = async () => readlink(join(root, "current"));
const failedAt = (tag: string, commit = GATED_COMMIT) => join(root, "failed", `${tag}@${commit}`);

linuxOnly("T19: the v3 update gate", () => {
  test("candidates: alphas above the gated one, NEWEST first, never edge", () => {
    expect(
      candidates(["edge", "v3.0.0-alpha.3", "v3.0.0-alpha.4", "v3.0.0-alpha.2", "v2.12.0"], 2),
    ).toEqual(["v3.0.0-alpha.4", "v3.0.0-alpha.3"]);
    expect(expectedSha(`${"a".repeat(64)}  x.tar.xz\n`, "/d/x.tar.xz")).toBe("a".repeat(64));
  });

  test("R586d: versions compare by their alpha number, not as text: alpha.10 is newer than alpha.9", () => {
    expect(
      candidates(["v3.0.0-alpha.9", "v3.0.0-alpha.10", "v3.0.0-alpha.3", "v3.0.0-alpha.2"], 2),
    ).toEqual(["v3.0.0-alpha.10", "v3.0.0-alpha.9", "v3.0.0-alpha.3"]);
  });

  const TAGS_345 = ["edge", "v3.0.0-alpha.3", "v3.0.0-alpha.5", "v3.0.0-alpha.4", "v3.0.0-alpha.2"];

  test("R586d: a newest pass stops the run: no older candidate is downloaded or gated", async () => {
    await setup();
    const { deps, seen } = fake({ outcome: "pass", tags: TAGS_345 });
    expect(await updateOnce(deps)).toEqual(["pass"]);
    expect(seen.tagsGated).toEqual(["v3.0.0-alpha.5"]);
    expect(seen.downloads).toBe(1);
    expect(await current()).toBe(join(root, "3.0.0-alpha.5-c893e3633"));
  });

  test("R586d: a newest fail falls back to the next older candidate, which passes and becomes current", async () => {
    await setup();
    const { deps, seen } = fake({
      tags: TAGS_345,
      byTag: { "v3.0.0-alpha.5": "gate-fail", "v3.0.0-alpha.4": "pass" },
    });
    expect(await updateOnce(deps)).toEqual(["gate-fail", "pass"]);
    expect(seen.tagsGated).toEqual(["v3.0.0-alpha.5", "v3.0.0-alpha.4"]);
    expect(await current()).toBe(join(root, "3.0.0-alpha.4-c893e3633"));
  });

  test("R586d: held and infra-fail also fall back to an older candidate", async () => {
    await setup();
    const { deps, seen } = fake({
      tags: TAGS_345,
      byTag: { "v3.0.0-alpha.5": "held", "v3.0.0-alpha.4": "infra-fail", "v3.0.0-alpha.3": "pass" },
    });
    expect(await updateOnce(deps)).toEqual(["held", "infra-fail", "pass"]);
    expect(seen.tagsGated).toEqual(["v3.0.0-alpha.5", "v3.0.0-alpha.4", "v3.0.0-alpha.3"]);
    expect(await current()).toBe(join(root, "3.0.0-alpha.3-c893e3633"));
  });

  test("R586d: all candidates fail: current is unchanged and each failure is recorded", async () => {
    await setup();
    const { deps, seen } = fake({ outcome: "gate-fail", tags: TAGS_345 });
    expect(await updateOnce(deps)).toEqual(["gate-fail", "gate-fail", "gate-fail"]);
    expect(seen.tagsGated).toEqual(["v3.0.0-alpha.5", "v3.0.0-alpha.4", "v3.0.0-alpha.3"]);
    for (const n of [3, 4, 5])
      expect(existsSync(join(failedAt(`v3.0.0-alpha.${n}`), "al-runner"))).toBe(true);
    expect(await current()).toBe(join(root, "3.0.0-alpha.2-91253f2d6"));
  });

  test("R586d: a candidate already in failed/<tag>@<this commit> is skipped without a gate; the next older one is tried", async () => {
    await setup();
    await mkdir(failedAt("v3.0.0-alpha.5"), { recursive: true });
    const { deps, seen } = fake({ outcome: "pass", tags: TAGS_345 });
    expect(await updateOnce(deps)).toEqual(["gate-fail", "pass"]);
    expect(seen.tagsGated).toEqual(["v3.0.0-alpha.4"]);
    expect(await current()).toBe(join(root, "3.0.0-alpha.4-c893e3633"));
  });

  test("pass: installed with .gated naming the gating commit, current moved; the gate ran at .gated's lethalCommit", async () => {
    await setup();
    const { deps, seen } = fake({ outcome: "pass" });
    expect(await updateOnce(deps)).toEqual(["pass"]);
    expect(seen.gates).toEqual([GATED_COMMIT]);
    const cur = await current();
    expect(cur).toBe(join(root, "3.0.0-alpha.3-c893e3633"));
    const g = JSON.parse(await readFile(join(cur, ".gated"), "utf8"));
    expect(g).toMatchObject({
      binarySha256: sha("alpha3"),
      lethalCommit: GATED_COMMIT,
      tarballSha256: sha("tarball"),
    });
  });

  test("R612 M-2: a pass writes the receipt's warn-fact readings into .gated, the diverged one included; none, none written", async () => {
    await setup();
    const { deps } = fake({
      outcome: "pass",
      warnFacts: { "serve-keep-reasons": "diverged" },
    });
    expect(await updateOnce(deps)).toEqual(["pass"]);
    const g = JSON.parse(await readFile(join(await current(), ".gated"), "utf8"));
    expect(g.warnFacts).toEqual({ "serve-keep-reasons": "diverged" });
    await setup();
    expect(await updateOnce(fake({ outcome: "pass" }).deps)).toEqual(["pass"]);
    const g2 = JSON.parse(await readFile(join(await current(), ".gated"), "utf8"));
    expect("warnFacts" in g2).toBe(false);
  });

  test("R614 I2: the gate's preparation line reaches the update log, tagged, on a pass and on a gate-fail", async () => {
    for (const outcome of ["pass", "gate-fail"] as const) {
      await setup();
      const { deps, seen } = fake({ outcome, prepLine: "fixture .alpackages: marked" });
      await updateOnce(deps);
      expect(seen.logs).toContain(
        "2026-10-21T00:00:00Z v3.0.0-alpha.3: fixture .alpackages: marked",
      );
    }
  });

  test("pass while a v3 process runs: installed, current NOT moved (deferred: in use)", async () => {
    await setup();
    const { deps, seen } = fake({ outcome: "pass", inUse: true });
    expect(await updateOnce(deps)).toEqual(["pass"]);
    expect(await current()).toBe(join(root, "3.0.0-alpha.2-91253f2d6"));
    expect(seen.logs.some((l) => l.includes("deferred: in use"))).toBe(true);
  });

  test("a stale receipt (another nonce) or another binary's is infra-fail; current stays", async () => {
    await setup();
    expect(await updateOnce(fake({ outcome: "pass", badNonce: true }).deps)).toEqual([
      "infra-fail",
    ]);
    expect(await updateOnce(fake({ outcome: "pass", badSha: true }).deps)).toEqual(["infra-fail"]);
    expect(await updateOnce(fake({}).deps)).toEqual(["infra-fail"]);
    expect(await current()).toBe(join(root, "3.0.0-alpha.2-91253f2d6"));
  });

  test("three infra-fails in a row print a line for the orchestrator; infra-fail keeps nothing", async () => {
    await setup();
    const { deps, seen } = fake({});
    for (let i = 0; i < 3; i++) await updateOnce(deps);
    expect(seen.logs.some((l) => l.includes("3 infra-fails in a row"))).toBe(true);
    expect(existsSync(failedAt("v3.0.0-alpha.3"))).toBe(false);
  });

  test("a checksum mismatch is infra-fail and the tarball is never extracted", async () => {
    await setup();
    const { deps, seen } = fake({ outcome: "pass", badSums: true });
    expect(await updateOnce(deps)).toEqual(["infra-fail"]);
    expect(seen.extracts).toBe(0);
    expect(seen.gates).toEqual([]);
  });

  test("gate-fail goes to failed/<tag>@<commit>: the next run at that commit does not gate it again", async () => {
    await setup();
    const a = fake({ outcome: "gate-fail" });
    expect(await updateOnce(a.deps)).toEqual(["gate-fail"]);
    expect(existsSync(join(failedAt("v3.0.0-alpha.3"), "al-runner"))).toBe(true);
    const b = fake({ outcome: "pass" });
    expect(await updateOnce(b.deps)).toEqual(["gate-fail"]);
    expect(b.seen.gates).toEqual([]);
  });

  test("RC-2 (I-2): a build that gate-failed is gated AGAIN after .gated moves to a new LethAL commit, and NOT at the same commit", async () => {
    await setup();
    // The build gate-fails at the old commit, through the gate itself.
    const first = fake({ outcome: "gate-fail" });
    expect(await updateOnce(first.deps)).toEqual(["gate-fail"]);
    expect(first.seen.gates).toEqual([GATED_COMMIT]);
    // At the SAME commit it is not gated again: the gate is never invoked.
    const same = fake({ outcome: "pass" });
    expect(await updateOnce(same.deps)).toEqual(["gate-fail"]);
    expect(same.seen.gates.length).toBe(0);
    // A LethAL fix moves .gated to a new commit: the same build is gated again (0 -> 1).
    const cur = await current();
    const gated = JSON.parse(await readFile(join(cur, ".gated"), "utf8"));
    await writeFile(join(cur, ".gated"), JSON.stringify({ ...gated, lethalCommit: FIXED_COMMIT }));
    const fixed = fake({ outcome: "held" });
    expect(fixed.seen.gates.length).toBe(0);
    expect(await updateOnce(fixed.deps)).toEqual(["held"]);
    expect(fixed.seen.gates).toEqual([FIXED_COMMIT]);
    expect(existsSync(join(root, "held", "v3.0.0-alpha.3"))).toBe(true);
  });

  test("held is kept under held/, never blacklisted, and current does not move", async () => {
    await setup();
    const { deps, seen } = fake({ outcome: "held" });
    expect(await updateOnce(deps)).toEqual(["held"]);
    expect(existsSync(join(root, "held", "v3.0.0-alpha.3"))).toBe(true);
    expect(existsSync(failedAt("v3.0.0-alpha.3"))).toBe(false);
    expect(await current()).toBe(join(root, "3.0.0-alpha.2-91253f2d6"));
    expect(seen.logs.some((l) => l.includes("HELD"))).toBe(true);
  });

  test("--regate gates the CURRENT build at the new commit; on pass .gated takes that commit", async () => {
    await setup();
    const { deps, seen } = fake({ outcome: "pass", receiptSha: sha("alpha2") });
    deps.versionOf = async () => "alrunner 3.0.0-alpha.2 (91253f2d6)";
    expect(await updateOnce(deps, { regateAt: REGATE_COMMIT })).toEqual(["pass"]);
    expect(seen.gates).toEqual([REGATE_COMMIT]);
    const g = JSON.parse(await readFile(join(await current(), ".gated"), "utf8"));
    expect(g.lethalCommit).toBe(REGATE_COMMIT);
  });

  test("R632 A: the gate gets LETHAL_ITEST_V3_CDO (the gate page's checkout by default), on a candidate and on --regate", async () => {
    await setup();
    const want = process.env.LETHAL_ITEST_V3_CDO ?? V3_CDO_DEFAULT;
    expect(V3_CDO_DEFAULT).toBe("/work/lethal-wt/cdo-r396");
    const a = fake({ outcome: "gate-fail" });
    await updateOnce(a.deps);
    expect(a.seen.envs.map((e) => e.LETHAL_ITEST_V3_CDO)).toEqual([want]);
    const b = fake({ outcome: "gate-fail", receiptSha: sha("alpha2") });
    await updateOnce(b.deps, { regateAt: REGATE_COMMIT });
    expect(b.seen.envs.map((e) => e.LETHAL_ITEST_V3_CDO)).toEqual([want]);
  });

  test("R632 C: the receipt is kept beside the outcome (failed/, held/, infra/, regate/) and its lines are logged", async () => {
    await setup();
    const line = "C: gate-fail: none-selected-exit: diverged, pre-committed matches";
    const a = fake({ outcome: "gate-fail", lines: [line] });
    expect(await updateOnce(a.deps)).toEqual(["gate-fail"]);
    const kept = join(failedAt("v3.0.0-alpha.3"), "receipt.json");
    expect(JSON.parse(await readFile(kept, "utf8")).lines).toEqual([line]);
    expect(a.seen.logs.join("\n")).toContain(line);

    await setup();
    const h = fake({ outcome: "held", lines: ["C: held: x"] });
    expect(await updateOnce(h.deps)).toEqual(["held"]);
    expect(existsSync(join(root, "held", "v3.0.0-alpha.3", "receipt.json"))).toBe(true);

    await setup();
    const i = fake({ outcome: "infra-fail", lines: ["D1: infra-fail: unset"] });
    expect(await updateOnce(i.deps)).toEqual(["infra-fail"]);
    const inf = join(root, "infra", "v3.0.0-alpha.3.receipt.json");
    expect(JSON.parse(await readFile(inf, "utf8")).lines).toEqual(["D1: infra-fail: unset"]);
    expect(i.seen.logs.join("\n")).toContain("D1: infra-fail: unset");

    await setup();
    const r = fake({ outcome: "gate-fail", receiptSha: sha("alpha2"), lines: ["T: gate-fail"] });
    expect(await updateOnce(r.deps, { regateAt: REGATE_COMMIT })).toEqual(["gate-fail"]);
    expect(existsSync(join(root, "regate", `${REGATE_COMMIT}.receipt.json`))).toBe(true);
    expect(existsSync(join(root, "failed"))).toBe(false);
  });

  test("R632 D: the failed/ early return is logged, with the --regate hint", async () => {
    await setup();
    await updateOnce(fake({ outcome: "gate-fail" }).deps);
    const b = fake({ outcome: "pass" });
    expect(await updateOnce(b.deps)).toEqual(["gate-fail"]);
    expect(b.seen.logs.join("\n")).toMatch(/already gate-failed at abcdef1.*--regate/);
  });

  test("R632 D: the alpha path and --regate are skipped with 3 other heavy jobs or under 10 GB; 2 and 10 proceed", async () => {
    await setup();
    for (const o of [{ heavy: 3 }, { free: 9 }]) {
      const a = fake({ outcome: "pass", ...o });
      expect(await updateOnce(a.deps)).toEqual(["skipped"]);
      const r = fake({ outcome: "pass", receiptSha: sha("alpha2"), ...o });
      expect(await updateOnce(r.deps, { regateAt: REGATE_COMMIT })).toEqual(["skipped"]);
      expect(a.seen.gates.length + r.seen.gates.length).toBe(0);
      expect(a.seen.logs.join("\n")).toMatch(/skipped for the day/);
    }
    expect(await updateOnce(fake({ outcome: "pass", heavy: 2, free: 10 }).deps)).toEqual(["pass"]);
  });

  test("R633 I1: gate.log is kept beside the outcome, even with no receipt, and the gate's error is logged", async () => {
    await setup();
    const i = fake({
      gateLog: "C: refusal-row-shape = diverged | exit 1",
      throwText: "exit 1: boom",
    });
    expect(await updateOnce(i.deps)).toEqual(["infra-fail"]);
    expect(await readFile(join(root, "infra", "v3.0.0-alpha.3.gate.log"), "utf8")).toContain(
      "refusal-row-shape = diverged",
    );
    expect(existsSync(join(root, "infra", "v3.0.0-alpha.3.receipt.json"))).toBe(false);
    expect(i.seen.logs.join("\n")).toContain("exit 1: boom");

    await setup();
    await updateOnce(fake({ outcome: "gate-fail", gateLog: "g" }).deps);
    expect(existsSync(join(failedAt("v3.0.0-alpha.3"), "gate.log"))).toBe(true);

    await setup();
    await updateOnce(fake({ outcome: "held", gateLog: "h" }).deps);
    expect(existsSync(join(root, "held", "v3.0.0-alpha.3", "gate.log"))).toBe(true);

    await setup();
    const r = fake({ outcome: "pass", receiptSha: sha("alpha2"), gateLog: "r" });
    await updateOnce(r.deps, { regateAt: REGATE_COMMIT });
    expect(existsSync(join(root, "regate", `${REGATE_COMMIT}.gate.log`))).toBe(true);
  });

  test("R633 M2: a failed copy is logged and never blocks the verdict (a regate pass still writes .gated)", async () => {
    await setup();
    await writeFile(join(root, "regate"), "a file where the folder should be");
    const { deps, seen } = fake({ outcome: "pass", receiptSha: sha("alpha2"), gateLog: "r" });
    expect(await updateOnce(deps, { regateAt: REGATE_COMMIT })).toEqual(["pass"]);
    const g = JSON.parse(await readFile(join(await current(), ".gated"), "utf8"));
    expect(g.lethalCommit).toBe(REGATE_COMMIT);
    expect(seen.logs.join("\n")).toMatch(/not kept/);
  });

  test("R633 I1: runToLog writes stdout and stderr to the log on every exit, and throws on non-zero", async () => {
    await setup();
    const log = join(root, "gate.log");
    await runToLog(["sh", "-c", "echo out-0; echo err-0 >&2"], {}, root, log);
    expect(await readFile(log, "utf8")).toMatch(/out-0[\s\S]*err-0/);
    await expect(
      runToLog(["sh", "-c", "echo out-3; echo err-3 >&2; exit 3"], {}, root, log),
    ).rejects.toThrow(/exit 3[\s\S]*err-3/);
    expect(await readFile(log, "utf8")).toMatch(/out-3[\s\S]*err-3/);
  });
});

describe("R633 I2 and M5", () => {
  test("I2: a skipped --regate exits 2; a skipped alpha run, or a regate that ran, exits 0", () => {
    expect(updateExitCode(true, ["skipped"])).toBe(2);
    expect(updateExitCode(false, ["skipped"])).toBe(0);
    expect(updateExitCode(true, ["pass"])).toBe(0);
  });
  test("M5: a heavy job is counted with a bare or a full-path bun; the update script is not", () => {
    for (const cmd of [
      "bun packages/runner/itest/al-runner-v3.itest.ts",
      "/home/dev/.bun/bin/bun packages/runner/itest/al-runner-v3.itest.ts",
      "/usr/local/bin/bun scripts/verify.ts",
    ])
      expect(HEAVY_JOB.test(cmd)).toBe(true);
    expect(HEAVY_JOB.test("bun scripts/al-runner-v3-update.ts --regate x")).toBe(false);
  });
});

describe("RC-3 (M3): the receipt must prove what it claims", () => {
  const write = async (r: object) => {
    const p = join(root, "receipt.json");
    await writeFile(p, JSON.stringify(r));
    return p;
  };
  const base = (o: object = {}) => ({
    nonce: "n",
    binarySha256: "s",
    lethalCommit: GATED_COMMIT,
    dirty: false,
    outcome: "pass",
    legs: legsFor("pass"),
    ...o,
  });
  test("every leg passed at the requested commit: pass", async () => {
    await setup();
    expect((await readReceipt(await write(base()), "n", "s", GATED_COMMIT)).outcome).toBe("pass");
  });
  test("outcome pass with a leg missing, or skipped, is infra-fail", async () => {
    await setup();
    const { T: _t, ...missing } = legsFor("pass");
    expect(
      (await readReceipt(await write(base({ legs: missing })), "n", "s", GATED_COMMIT)).outcome,
    ).toBe("infra-fail");
    expect(
      (
        await readReceipt(
          await write(base({ legs: { ...legsFor("pass"), X: "skipped" } })),
          "n",
          "s",
          GATED_COMMIT,
        )
      ).outcome,
    ).toBe("infra-fail");
    expect(
      (await readReceipt(await write(base({ legs: {} })), "n", "s", GATED_COMMIT)).outcome,
    ).toBe("infra-fail");
  });
  test("R632 A: an infra-fail receipt that lacks legs names the missing legs in why", async () => {
    await setup();
    const { D1: _d, D1c: _c, ...legs } = legsFor("pass");
    const r = await readReceipt(
      await write(base({ outcome: "infra-fail", legs })),
      "n",
      "s",
      GATED_COMMIT,
    );
    expect(r.outcome).toBe("infra-fail");
    expect(r.why).toMatch(/missing legs D1,D1c/);
    const full = await readReceipt(await write(base()), "n", "s", GATED_COMMIT);
    expect(full.why).not.toMatch(/missing/);
  });
  test("outcome pass with a gate-fail leg is infra-fail (the legs and the outcome disagree)", async () => {
    await setup();
    const legs = { ...legsFor("pass"), S1: "gate-fail" };
    const r = await readReceipt(await write(base({ legs })), "n", "s", GATED_COMMIT);
    expect(r.outcome).toBe("infra-fail");
    expect(r.why).toMatch(/give gate-fail/);
  });
  test("a receipt of another LethAL commit is infra-fail", async () => {
    await setup();
    const r = await readReceipt(
      await write(base({ lethalCommit: "0000000aaaaaaa" })),
      "n",
      "s",
      GATED_COMMIT,
    );
    expect(r.outcome).toBe("infra-fail");
    expect(r.why).toMatch(/not the requested/);
  });
  test("F6: a PREFIX of the requested commit, either way, is infra-fail; only the full equal sha passes", async () => {
    await setup();
    for (const at of [GATED_COMMIT.slice(0, 2), GATED_COMMIT.slice(0, 12)]) {
      const r = await readReceipt(await write(base({ lethalCommit: at })), "n", "s", GATED_COMMIT);
      expect(r.outcome).toBe("infra-fail");
    }
    const short = await readReceipt(await write(base()), "n", "s", GATED_COMMIT.slice(0, 12));
    expect(short.outcome).toBe("infra-fail");
  });
  test("F5: a pass from a dirty gate worktree (or one that does not say) is infra-fail", async () => {
    await setup();
    for (const dirty of [true, undefined]) {
      const r = await readReceipt(await write(base({ dirty })), "n", "s", GATED_COMMIT);
      expect(r.outcome).toBe("infra-fail");
      expect(r.why).toMatch(/not clean/);
    }
  });
});

// The fixture .alpackages half (R614) is `prepareFixtureSymbols`, tested in
// packages/runner/tests/fixture-symbols.test.ts.
describe("M4: the gate worktree is prepared", () => {
  test("bun install (F5: --frozen-lockfile) and the native parser build always run", () => {
    expect(GATE_STEPS).toEqual([
      ["bun", "install", "--frozen-lockfile"],
      ["bun", "scripts/build-native-parser.ts"],
    ]);
  });
});

linuxOnly("the daily edge path (edgeOnce)", () => {
  const edge = (
    o: Parameters<typeof fake>[0],
    e: { commit?: string; heavy?: number; free?: number } = {},
  ) => {
    const f = fake(o);
    return {
      ...f,
      deps: {
        ...f.deps,
        edgeCommit: async () => e.commit ?? "c893e3633",
        heavyJobs: async () => e.heavy ?? 0,
        freeGb: async () => e.free ?? 20,
      },
    };
  };

  test("an unchanged edge commit is a no-op: nothing downloaded or gated", async () => {
    await setup();
    await writeFile(join(root, "edge.last-seen"), "c893e3633\n");
    const { deps, seen } = edge({ outcome: "pass" });
    expect(await edgeOnce(deps)).toBe("no-op");
    expect(seen.gates).toEqual([]);
    expect(seen.extracts).toBe(0);
  });

  test("a new commit is gated; a pass moves the pointer and records the commit as seen", async () => {
    await setup();
    await writeFile(join(root, "edge.last-seen"), "0000000aaa\n");
    const { deps, seen } = edge({ outcome: "pass" });
    expect(await edgeOnce(deps)).toBe("pass");
    expect(seen.gates).toEqual([GATED_COMMIT]);
    expect(await current()).not.toBe(join(root, "3.0.0-alpha.2-91253f2d6"));
    expect((await readFile(join(root, "edge.last-seen"), "utf8")).trim()).toBe("c893e3633");
  });

  test("R586d: --edge stays a single candidate: a failing edge never falls back to a release", async () => {
    await setup();
    const { deps, seen } = edge({
      outcome: "gate-fail",
      tags: ["edge", "v3.0.0-alpha.5", "v3.0.0-alpha.4", "v3.0.0-alpha.2"],
    });
    expect(await edgeOnce(deps)).toBe("gate-fail");
    expect(seen.tagsGated).toEqual(["edge-c893e3633"]);
    expect(await current()).toBe(join(root, "3.0.0-alpha.2-91253f2d6"));
  });

  test("a bad hash is refused and nothing is extracted; the commit is NOT marked seen (retried)", async () => {
    await setup();
    const { deps, seen } = edge({ outcome: "pass", badSums: true });
    expect(await edgeOnce(deps)).toBe("infra-fail");
    expect(seen.extracts).toBe(0);
    expect(existsSync(join(root, "edge.last-seen"))).toBe(false);
  });

  test("a gate-fail leaves the pointer unmoved; held is kept, not blacklisted", async () => {
    await setup();
    expect(await edgeOnce(edge({ outcome: "gate-fail" }).deps)).toBe("gate-fail");
    expect(await current()).toBe(join(root, "3.0.0-alpha.2-91253f2d6"));
    await rm(join(root, "edge.last-seen"));
    expect(await edgeOnce(edge({ outcome: "held" }, { commit: "d00d00d00" }).deps)).toBe("held");
    expect(existsSync(join(root, "held", "edge-d00d00d00"))).toBe(true);
    expect(existsSync(failedAt("edge-d00d00d00"))).toBe(false);
    expect(await current()).toBe(join(root, "3.0.0-alpha.2-91253f2d6"));
  });

  test("skipped with 3 other heavy jobs or under 10 GB; 2 other heavy jobs and 10 GB proceed", async () => {
    await setup();
    const a = edge({ outcome: "pass" }, { heavy: 3 });
    expect(await edgeOnce(a.deps)).toBe("skipped");
    expect(a.seen.logs.join("\n")).toMatch(/3 heavy jobs are running \(limit: 2 others\)/);
    const b = edge({ outcome: "pass" }, { free: 9 });
    expect(await edgeOnce(b.deps)).toBe("skipped");
    expect(b.seen.logs.join("\n")).toMatch(/9 GB/);
    expect(a.seen.gates.length + b.seen.gates.length).toBe(0);
    const c = edge({ outcome: "pass" }, { heavy: 2, free: 10 });
    expect(await edgeOnce(c.deps)).toBe("pass");
  });
});

// R639 I3: one lock around every gate path.
linuxOnly("R639 the gate lock (L1-L6)", () => {
  const lockPath = () => join(root, ".gate.lock");
  const holder = (pid: number) =>
    writeFile(lockPath(), JSON.stringify({ pid, startedAt: "2026-10-20T00:00:00Z", argv: [] }));
  const regate = (o: Parameters<typeof fake>[0]) => {
    const f = fake({ outcome: "pass", receiptSha: sha("alpha2"), ...o });
    f.deps.versionOf = async () => "alrunner 3.0.0-alpha.2 (91253f2d6)";
    return f;
  };

  test("L1: a live holder: skipped, exit 2, the gate never runs; the log names the lock, pid and the clear step", async () => {
    await setup();
    await holder(4242);
    const { deps, seen } = regate({ procs: { 4242: "bun scripts/al-runner-v3-update.ts --edge" } });
    const out = await updateOnce(deps, { regateAt: REGATE_COMMIT });
    expect(out).toEqual(["skipped"]);
    expect(updateExitCode(true, out)).toBe(2);
    expect(seen.gates).toEqual([]);
    expect(seen.logs.join("\n")).toContain(`${lockPath()} is held by pid 4242`);
    expect(seen.logs.join("\n")).toContain(`rm ${lockPath()}`);
  });

  test("L2: a dead holder AND a process with its cwd under the gate worktree: skipped, the orphan named", async () => {
    await setup();
    await holder(4242);
    const { deps, seen } = regate({ orphans: [777] });
    expect(await updateOnce(deps, { regateAt: REGATE_COMMIT })).toEqual(["skipped"]);
    expect(seen.gates).toEqual([]);
    expect(seen.logs.join("\n")).toMatch(/pid\(s\) 777 still run under/);
  });

  test("L3: a dead holder, no orphan: taken over (renamed, then linked), gated, and released", async () => {
    await setup();
    await holder(4242);
    const { deps, seen } = regate({});
    expect(await updateOnce(deps, { regateAt: REGATE_COMMIT })).toEqual(["pass"]);
    expect(seen.gates).toEqual([REGATE_COMMIT]);
    expect(seen.logs.join("\n")).toMatch(/took over the stale gate lock/);
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(root)).filter((n) => n.startsWith(".gate.lock.stale.")).length).toBe(1);
    expect(existsSync(lockPath())).toBe(false);
  });

  test("L4: an EMPTY lock file is reported and taken over; it never blocks silently", async () => {
    await setup();
    await writeFile(lockPath(), "");
    const { deps, seen } = regate({});
    expect(await updateOnce(deps, { regateAt: REGATE_COMMIT })).toEqual(["pass"]);
    expect(seen.logs.join("\n")).toMatch(/is empty or unreadable: stale/);
  });

  test("L5: a live pid running ANOTHER program (pid reuse) is stale: gated", async () => {
    await setup();
    await holder(4242);
    const { deps, seen } = regate({ procs: { 4242: "/usr/bin/vim notes.txt" } });
    expect(await updateOnce(deps, { regateAt: REGATE_COMMIT })).toEqual(["pass"]);
    expect(seen.gates).toEqual([REGATE_COMMIT]);
  });

  test("L7 (M2): a holder whose pid is THIS process (pid reuse after a restart) is stale: gated", async () => {
    await setup();
    await holder(process.pid);
    const { deps, seen } = regate({
      procs: { [process.pid]: "bun scripts/al-runner-v3-update.ts --regate" },
    });
    expect(await updateOnce(deps, { regateAt: REGATE_COMMIT })).toEqual(["pass"]);
    expect(seen.gates).toEqual([REGATE_COMMIT]);
  });

  test("L6: a lock that is no longer ours is left alone at release; our own is removed", async () => {
    await setup();
    const other = JSON.stringify({ pid: 99, startedAt: "x", argv: [] });
    const { deps } = regate({ onGate: () => writeFile(lockPath(), other) });
    await updateOnce(deps, { regateAt: REGATE_COMMIT });
    expect(await readFile(lockPath(), "utf8")).toBe(other);
    await setup();
    await updateOnce(regate({}).deps, { regateAt: REGATE_COMMIT });
    expect(existsSync(lockPath())).toBe(false);
  });
});

// R639 `--edge-rejudge <sha>` (plan r2 §6, r3 I4/I5, M4/M5).
linuxOnly("R639 --edge-rejudge (R1-R9)", () => {
  const EDGE = "57f1e4f98";
  const TAG = `edge-${EDGE}`;
  const OLD = "de8f43e2de8f43e2de8f43e2de8f43e2de8f43e2";
  const EDGE_VERSION = `al-runner 3.0.0-alpha.4+edge.20261022 (${EDGE})`;
  const kept = (name = `${TAG}@${OLD}`) => join(root, "failed", name);

  /** `.gated` at GATED_COMMIT (with a tarball, for M5), and the kept edge build at OLD. */
  async function setupKept(o: { bytes?: string; receiptSha?: string; name?: string } = {}) {
    await setup();
    const cur = await current();
    const g = JSON.parse(await readFile(join(cur, ".gated"), "utf8"));
    await writeFile(
      join(cur, ".gated"),
      JSON.stringify({ ...g, tarballSha256: sha("alpha2-tarball") }),
    );
    const d = kept(o.name);
    await mkdir(d, { recursive: true });
    await writeFile(join(d, "al-runner"), o.bytes ?? "edge57");
    await writeFile(
      join(d, "receipt.json"),
      JSON.stringify({
        binarySha256: o.receiptSha ?? sha("edge57"),
        outcome: "gate-fail",
        lethalCommit: OLD,
      }),
    );
    await writeFile(join(root, "edge.last-seen"), "0123abc\n");
  }
  const rj = (o: Parameters<typeof fake>[0] = {}) =>
    fake({ outcome: "gate-fail", receiptSha: sha("edge57"), version: EDGE_VERSION, ...o });

  /** Every path under failed/ and held/, with its bytes. */
  async function tree(): Promise<Record<string, string>> {
    const { readdir } = await import("node:fs/promises");
    const out: Record<string, string> = {};
    for (const top of ["failed", "held"]) {
      const base = join(root, top);
      if (!existsSync(base)) continue;
      for (const e of await readdir(base, { recursive: true, withFileTypes: true }))
        if (e.isFile()) {
          const p = join(e.parentPath, e.name);
          out[p] = await readFile(p, "utf8");
        }
    }
    return out;
  }

  test("R1: skipped with 3 other heavy jobs, under 10 GB, or a live lock: exit 2 and no gate", async () => {
    for (const o of [
      { heavy: 3 },
      { free: 9 },
      { procs: { 4242: "bun al-runner-v3-update.ts" } },
    ]) {
      await setupKept();
      await writeFile(join(root, ".gate.lock"), JSON.stringify({ pid: 4242, startedAt: "t" }));
      const { deps, seen } = rj(o);
      const out = await edgeRejudge(deps, EDGE);
      expect(out).toBe("skipped");
      expect(updateExitCode(true, [out])).toBe(2);
      expect(seen.gates).toEqual([]);
    }
  });

  test("R2 (I5): failed/<tag>@<current commit> with NO receipt refuses by name; the gate never runs", async () => {
    await setupKept();
    await mkdir(failedAt(TAG), { recursive: true });
    const { deps, seen } = rj();
    await expect(edgeRejudge(deps, EDGE)).rejects.toThrow(
      `al-runner-v3-edge-rejudge-refused: ${TAG} already judged at ${GATED_COMMIT}; --regate to a new commit first`,
    );
    expect(seen.gates).toEqual([]);
  });

  test("R2 (I5): a rejudge receipt at this commit refuses unless it was an infra-fail", async () => {
    for (const [outcome, refused] of [
      ["held", true],
      ["infra-fail", false],
    ] as const) {
      await setupKept();
      const d = join(root, "rejudge", `${TAG}@${GATED_COMMIT}`);
      await mkdir(d, { recursive: true });
      await writeFile(
        join(d, "receipt.json"),
        JSON.stringify({ lethalCommit: GATED_COMMIT, outcome }),
      );
      const p = edgeRejudge(rj().deps, EDGE);
      if (refused) await expect(p).rejects.toThrow(/already judged/);
      else expect(await p).toBe("gate-fail");
    }
  });

  test("R3: gateOne with a kept binary and an existing failed/<tag>@<commit> is gate-fail; the gate never runs", async () => {
    await setupKept();
    await mkdir(failedAt(TAG), { recursive: true });
    const { deps, seen } = rj({ outcome: "pass" });
    const g = parseGated(await readFile(join(await current(), ".gated"), "utf8"), ".gated");
    const binary = join(kept(), "al-runner");
    expect(await gateOne(deps, TAG, g, { binary, binarySha256: sha("edge57") })).toBe("gate-fail");
    expect(seen.gates).toEqual([]);
  });

  test("R4 (I4): a kept binary whose --version commit is another build is refused", async () => {
    await setupKept();
    const { deps, seen } = rj({ version: "al-runner 3.0.0-alpha.4+edge.20261021 (7739d8132)" });
    await expect(edgeRejudge(deps, EDGE)).rejects.toThrow(
      /reports commit "7739d8132", not 57f1e4f98/,
    );
    expect(seen.gates).toEqual([]);
  });

  test("R4 (I4): a folder whose tag only starts with the tag is not a kept copy of it", async () => {
    await setupKept({ name: `${TAG}0@${OLD}` });
    await expect(edgeRejudge(rj().deps, EDGE)).rejects.toThrow(/no kept binary with a receipt/);
  });

  test("R4 (M3): a folder with NO @ that is the tag plus one character is not a kept copy of it", async () => {
    await setupKept({ name: `${TAG}X` });
    await expect(edgeRejudge(rj().deps, EDGE)).rejects.toThrow(/no kept binary with a receipt/);
  });

  test("R5: custody: a binary that is not its receipt's bytes is refused", async () => {
    await setupKept({ receiptSha: sha("other") });
    const { deps, seen } = rj();
    await expect(edgeRejudge(deps, EDGE)).rejects.toThrow(/its receipt names/);
    expect(seen.gates).toEqual([]);
  });

  test("R5: custody: two kept folders with different builds are refused", async () => {
    await setupKept();
    const h = join(root, "held", TAG);
    await mkdir(h, { recursive: true });
    await writeFile(join(h, "al-runner"), "edge57-other");
    await writeFile(
      join(h, "receipt.json"),
      JSON.stringify({ binarySha256: sha("edge57-other"), outcome: "held", lethalCommit: OLD }),
    );
    await expect(edgeRejudge(rj().deps, EDGE)).rejects.toThrow(/two different kept builds/);
  });

  test("R5 (M4): gateOne refuses when the binary's sha is not the custody-checked one", async () => {
    await setupKept();
    const { deps, seen } = rj();
    const g = parseGated(await readFile(join(await current(), ".gated"), "utf8"), ".gated");
    await expect(
      gateOne(deps, TAG, g, { binary: join(kept(), "al-runner"), binarySha256: sha("x") }),
    ).rejects.toThrow(/not the custody-checked/);
    expect(seen.gates).toEqual([]);
  });

  test("R6: the KEPT binary is gated, as a candidate, never a download", async () => {
    await setupKept();
    const { deps, seen } = rj();
    expect(await edgeRejudge(deps, EDGE)).toBe("gate-fail");
    expect(seen.downloads).toBe(0);
    expect(seen.extracts).toBe(0);
    expect(seen.envs[0]?.LETHAL_ALRUNNER_V3_PATH).toBe(join(kept(), "al-runner"));
    expect(seen.envs[0]?.LETHAL_ALRUNNER_V3_CANDIDATE).toBe("1");
    expect(seen.gates).toEqual([GATED_COMMIT]);
  });

  test("R7: for each outcome, nothing that existed under failed/ or held/ changes its bytes or goes away", async () => {
    for (const outcome of ["pass", "held", "gate-fail", "infra-fail"] as const) {
      for (const heldBefore of [false, true]) {
        await setupKept();
        if (heldBefore) {
          // A real earlier held copy (the same bytes, with its receipt), so a rewrite would show.
          const h = join(root, "held", TAG);
          await mkdir(h, { recursive: true });
          await writeFile(join(h, "note.txt"), "an earlier held");
          await writeFile(join(h, "al-runner"), "edge57");
          await writeFile(
            join(h, "receipt.json"),
            JSON.stringify({ binarySha256: sha("edge57"), outcome: "held", lethalCommit: OLD }),
          );
        }
        const before = await tree();
        expect(await edgeRejudge(rj({ outcome }).deps, EDGE)).toBe(outcome);
        const after = await tree();
        for (const [p, bytes] of Object.entries(before)) expect(after[p]).toBe(bytes);
        expect(existsSync(failedAt(TAG))).toBe(outcome === "gate-fail");
      }
    }
  });

  test("R8 (M5): a rejudge pass writes .gated with rejudgedFrom and NO inherited tarballSha256", async () => {
    await setupKept();
    expect(await edgeRejudge(rj({ outcome: "pass" }).deps, EDGE)).toBe("pass");
    const g = JSON.parse(await readFile(join(await current(), ".gated"), "utf8"));
    expect(g.rejudgedFrom).toBe(kept());
    expect("tarballSha256" in g).toBe(false);
    expect(g).toMatchObject({ version: EDGE_VERSION, lethalCommit: GATED_COMMIT });
  });

  test("R9: rejudge/<tag>@<commit>/ keeps the receipt and gate.log, edge.last-seen is untouched, the line says same or different", async () => {
    await setupKept();
    const a = rj({ gateLog: "C: refusal-row-shape = unlike-bc" });
    expect(await edgeRejudge(a.deps, EDGE)).toBe("gate-fail");
    const d = join(root, "rejudge", `${TAG}@${GATED_COMMIT}`);
    expect(existsSync(join(d, "receipt.json"))).toBe(true);
    expect(await readFile(join(d, "gate.log"), "utf8")).toContain("unlike-bc");
    expect(await readFile(join(root, "edge.last-seen"), "utf8")).toBe("0123abc\n");
    expect(a.seen.logs.join("\n")).toContain(
      `edge-rejudge ${TAG} (${sha("edge57")}) at ${GATED_COMMIT}: gate-fail; before: gate-fail@${OLD}; same`,
    );
    await setupKept();
    const b = rj({ outcome: "held" });
    await edgeRejudge(b.deps, EDGE);
    expect(b.seen.logs.join("\n")).toMatch(/: held; before: gate-fail@de8f43e2\w+; different/);
  });

  test("the argument must be a 7-40 character sha", async () => {
    await setupKept();
    for (const bad of ["57f1e4", "edge", "57F1E4F98"])
      await expect(edgeRejudge(rj().deps, bad)).rejects.toThrow(
        /al-runner-v3-edge-rejudge-refused/,
      );
  });
});
