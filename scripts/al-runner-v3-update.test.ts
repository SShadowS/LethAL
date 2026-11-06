// R586 T19 (plan r2 §12, r3 F6, r4 I-3): the v3 update gate with fakes, every outcome both ways.
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { V3_GATE_LEGS } from "../packages/runner/itest/al-runner-v3-gate";
import { parseGated } from "../packages/runner/src/al-runner-v3-pin";
import {
  type GatedBuildEntry,
  V3_BUILD_PINS,
  v3ReadingsDigest,
} from "../packages/runner/src/al-runner-v3-pins";
import {
  type CommitOrder,
  GATED_BUILDS_FILE,
  GATE_STEPS,
  HEAVY_JOB,
  type Outcome,
  type PublishResult,
  type UpdateDeps,
  V3_CDO_DEFAULT,
  candidates,
  countHeavyJobs,
  dailyOnce,
  edgeOnce,
  edgeRejudge,
  expectedSha,
  gateOne,
  parseGateLegs,
  pinDigests,
  publishPending,
  publishToMaster,
  readReceipt,
  realDeps,
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

/** The readings digest of a hand pin, as a gate's receipt reports it. */
const digestOfPin = (id: string): string => {
  const p = V3_BUILD_PINS.find((x) => x.id === id);
  return p === undefined ? "" : v3ReadingsDigest(p);
};

/** Legs that give `o` by gateOutcome over the exact leg set (M3). */
const legsFor = (o: Outcome): Record<string, string> => ({
  ...Object.fromEntries(V3_GATE_LEGS.map((l, i) => [l, i === 0 ? o : "pass"])),
  K: "pass",
});

function fake(o: {
  /** R814: the receipt's `pinApplied`, and what the fakes answer. */
  pinApplied?: string;
  order?: CommitOrder;
  orderThrows?: boolean;
  noPinFromAt?: string[];
  pinsMovedAt?: string[];
  pinDigest?: string;
  listed?: readonly GatedBuildEntry[];
  publish?: (e: readonly GatedBuildEntry[]) => Promise<PublishResult>;
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
  /** R777: the legs per LethAL commit (absent: all of `V3_GATE_LEGS`), and the script's commit. */
  legsByCommit?: Record<string, readonly string[]>;
  self?: string;
  /** R777: `isAncestor` (default: true only toward origin/master). */
  ancestor?: (a: string, b: string) => boolean;
  /** R777: outcomes per gate call, in order, before `byTag` and `outcome`. */
  seq?: Outcome[];
  /** R777: the receipt names the sha256 of the binary actually gated. */
  realSha?: boolean;
}) {
  let lastTag = "";
  const seen = {
    tagsGated: [] as string[],
    gates: [] as string[],
    envs: [] as Readonly<Record<string, string>>[],
    extracts: 0,
    downloads: 0,
    logs: [] as string[],
    published: [] as string[],
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
      const outcome = o.seq?.shift() ?? o.byTag?.[lastTag] ?? o.outcome;
      const gatedSha =
        o.realSha === true
          ? sha(await readFile(env.LETHAL_ALRUNNER_V3_PATH ?? "", "utf8"))
          : undefined;
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
          binarySha256:
            gatedSha ?? o.receiptSha ?? (o.badSha === true ? sha("other") : sha("alpha3")),
          lethalCommit: o.receiptCommit ?? commit,
          dirty: false,
          outcome,
          legs: o.legs ?? legsFor(outcome),
          lines: o.lines ?? [],
          ...(o.warnFacts !== undefined ? { warnFacts: o.warnFacts } : {}),
          ...(o.pinApplied !== undefined
            ? { pinApplied: o.pinApplied, pinDigest: o.pinDigest ?? digestOfPin(o.pinApplied) }
            : {}),
        }),
      );
      if (o.throwText !== undefined) throw new Error(o.throwText);
    },
    pinFromAt: async (c) => !(o.noPinFromAt ?? []).includes(c),
    pinsMovedSince: async (c) => (o.pinsMovedAt ?? []).includes(c),
    commitOrder: async () => {
      if (o.orderThrows === true) throw new Error("compare failed");
      return o.order ?? "ahead";
    },
    publishEntries:
      o.publish ??
      (async (e) => {
        seen.published.push(...e.map((x) => x.id));
        return { published: e.map((x) => x.id), refused: [] };
      }),
    // alpha.2 stands for the seed row: every older test's candidates start above it.
    listedBuilds: () =>
      o.listed ??
      ([{ id: "a2", track: "release", tag: "v3.0.0-alpha.2" }] as unknown as GatedBuildEntry[]),
    inUse: async () => o.inUse === true,
    log: async (l) => {
      seen.logs.push(l);
    },
    now: () => "2026-10-21T00:00:00Z",
    legsAt: async (c) => o.legsByCommit?.[c] ?? V3_GATE_LEGS,
    selfCommit: async () => o.self ?? FIXED_COMMIT,
    isAncestor: async (a, b) => o.ancestor?.(a, b) ?? b === "origin/master",
  };
  return { deps, seen };
}

const current = async () => readlink(join(root, "current"));
const ALPHA2_DIR = "3.0.0-alpha.2-91253f2d6";
const ALPHA3_DIR = "3.0.0-alpha.3-c893e3633";
const EDGE_DIR = "edge-c893e3633-c893e3633";
/** R814: a release's pass installs its own folder and leaves `current` where it was. */
const releaseOnlyInstalled = async (dir: string) => {
  expect(existsSync(join(root, dir, "al-runner"))).toBe(true);
  expect(await current()).toBe(join(root, ALPHA2_DIR));
};
/** The edge path's deps, on a fake. */
const edgeOf = (o: Parameters<typeof fake>[0], commit = "c893e3633") => {
  const f = fake(o);
  return { ...f, deps: { ...f.deps, edgeCommit: async () => commit } };
};
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
      candidates(
        [
          "v3.0.0-alpha.9",
          "v3.0.0-alpha.10",
          "v3.0.0-alpha.3",
          "v3.0.0-alpha.2",
          "v3.0.0-alpha.1",
          "v3.0.0-alpha.5+edge.1",
        ],
        2,
      ),
    ).toEqual(["v3.0.0-alpha.10", "v3.0.0-alpha.9", "v3.0.0-alpha.3"]);
  });

  const TAGS_345 = [
    "edge",
    "v3.0.0-alpha.3",
    "v3.0.0-alpha.5",
    "v3.0.0-alpha.4",
    "v3.0.0-alpha.2",
    "v3.0.0-alpha.1",
  ];

  test("R586d: a newest pass stops the run: no older candidate is downloaded or gated", async () => {
    await setup();
    const { deps, seen } = fake({ outcome: "pass", tags: TAGS_345 });
    expect(await updateOnce(deps)).toEqual(["pass"]);
    expect(seen.tagsGated).toEqual(["v3.0.0-alpha.5"]);
    expect(seen.downloads).toBe(1);
    await releaseOnlyInstalled("3.0.0-alpha.5-c893e3633");
  });

  test("R586d: a newest fail falls back to the next older candidate, which passes", async () => {
    await setup();
    const { deps, seen } = fake({
      tags: TAGS_345,
      byTag: { "v3.0.0-alpha.5": "gate-fail", "v3.0.0-alpha.4": "pass" },
    });
    expect(await updateOnce(deps)).toEqual(["gate-fail", "pass"]);
    expect(seen.tagsGated).toEqual(["v3.0.0-alpha.5", "v3.0.0-alpha.4"]);
    await releaseOnlyInstalled("3.0.0-alpha.4-c893e3633");
  });

  test("R586d: held and infra-fail also fall back to an older candidate", async () => {
    await setup();
    const { deps, seen } = fake({
      tags: TAGS_345,
      byTag: { "v3.0.0-alpha.5": "held", "v3.0.0-alpha.4": "infra-fail", "v3.0.0-alpha.3": "pass" },
    });
    expect(await updateOnce(deps)).toEqual(["held", "infra-fail", "pass"]);
    expect(seen.tagsGated).toEqual(["v3.0.0-alpha.5", "v3.0.0-alpha.4", "v3.0.0-alpha.3"]);
    await releaseOnlyInstalled("3.0.0-alpha.3-c893e3633");
    expect(
      seen.logs.some((l) =>
        l.includes("v3.0.0-alpha.3: passed after v3.0.0-alpha.4 was not judged (infra-fail) today"),
      ),
    ).toBe(true);
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
    await releaseOnlyInstalled("3.0.0-alpha.4-c893e3633");
  });

  test("an edge pass: installed with .gated naming the gating commit, current moved; the gate ran at .gated's lethalCommit", async () => {
    await setup();
    const { deps, seen } = edgeOf({ outcome: "pass" });
    expect(await edgeOnce(deps)).toBe("pass");
    expect(seen.gates).toEqual([GATED_COMMIT]);
    const cur = await current();
    expect(cur).toBe(join(root, EDGE_DIR));
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
    const g = JSON.parse(await readFile(join(root, ALPHA3_DIR, ".gated"), "utf8"));
    expect(g.warnFacts).toEqual({ "serve-keep-reasons": "diverged" });
    await setup();
    expect(await updateOnce(fake({ outcome: "pass" }).deps)).toEqual(["pass"]);
    const g2 = JSON.parse(await readFile(join(root, ALPHA3_DIR, ".gated"), "utf8"));
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

  test("an edge pass while a v3 process runs: installed, current NOT moved, and retried (edge not marked seen)", async () => {
    await setup();
    const { deps, seen } = edgeOf({ outcome: "pass", inUse: true });
    expect(await edgeOnce(deps)).toBe("pass");
    expect(await current()).toBe(join(root, ALPHA2_DIR));
    expect(seen.logs.some((l) => l.includes("deferred: in use"))).toBe(true);
    expect(existsSync(join(root, "edge.last-seen"))).toBe(false);
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

  test("R805: a pass keeps its receipt and gate.log beside .gated; a gate-fail keeps them only under failed/", async () => {
    await setup();
    await updateOnce(fake({ outcome: "pass", gateLog: "O1: commit kind" }).deps);
    const dest = join(root, ALPHA3_DIR);
    expect(await readFile(join(dest, "gate.log"), "utf8")).toBe("O1: commit kind");
    expect(JSON.parse(await readFile(join(dest, "receipt.json"), "utf8")).outcome).toBe("pass");

    await setup();
    await updateOnce(fake({ outcome: "gate-fail", gateLog: "g" }).deps);
    expect(existsSync(join(failedAt("v3.0.0-alpha.3"), "gate.log"))).toBe(true);
    expect(existsSync(join(root, "3.0.0-alpha.3-c893e3633"))).toBe(false);
  });

  test("R805: a deferred pass and an edge pass keep both files; a regate pass leaves the build folder alone", async () => {
    await setup();
    await edgeOnce(edgeOf({ outcome: "pass", gateLog: "d", inUse: true }).deps);
    const deferred = join(root, EDGE_DIR);
    expect(await current()).toBe(join(root, ALPHA2_DIR));
    expect(existsSync(join(deferred, "gate.log"))).toBe(true);
    expect(existsSync(join(deferred, "receipt.json"))).toBe(true);

    await setup();
    const e = fake({ outcome: "pass", gateLog: "e" });
    await edgeOnce({ ...e.deps, edgeCommit: async () => "c893e3633" });
    expect(existsSync(join(await current(), "gate.log"))).toBe(true);
    expect(existsSync(join(await current(), "receipt.json"))).toBe(true);

    await setup();
    const r = fake({ outcome: "pass", receiptSha: sha("alpha2"), gateLog: "r" });
    await updateOnce(r.deps, { regateAt: REGATE_COMMIT });
    expect(existsSync(join(await current(), "gate.log"))).toBe(false);
    expect(existsSync(join(await current(), "receipt.json"))).toBe(false);
  });

  test("R805: a re-pass of one build keeps only the latest log; a failed copy still moves current", async () => {
    await setup();
    const dest = join(root, ALPHA3_DIR);
    await mkdir(dest);
    await writeFile(join(dest, "gate.log"), "an older pass");
    await updateOnce(fake({ outcome: "pass", gateLog: "the latest pass" }).deps);
    expect(await readFile(join(dest, "gate.log"), "utf8")).toBe("the latest pass");

    await setup();
    await mkdir(join(root, EDGE_DIR, "gate.log"), { recursive: true });
    const { deps, seen } = edgeOf({ outcome: "pass", gateLog: "p" });
    expect(await edgeOnce(deps)).toBe("pass");
    expect(await current()).toBe(join(root, EDGE_DIR));
    expect(seen.logs.join("\n")).toMatch(/gate\.log not kept/);
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
  test("R851: one job counts once, whatever its wrappers and workers", () => {
    const job = 77;
    const p = (pid: number, args: string, pgid = job) => ({ pid, ppid: 1, pgid, args });
    const procs = [
      p(1, "bash -c cd /x && bun packages/runner/itest/al-runner-v3.itest.ts"),
      p(2, "flock -n -E 111 /coord/locks/heavy.1 bun packages/runner/itest/al-runner-v3.itest.ts"),
      p(3, "bun packages/runner/itest/al-runner-v3.itest.ts"),
      p(4, "/home/dev/.bun/bin/bun packages/runner/itest/al-runner-v3.itest.ts"),
      p(5, "bun packages/runner/itest/al-runner-v3.itest.ts --worker 1", 88),
    ];
    expect(countHeavyJobs(procs, 1)).toBe(1);
  });
  test("R851: three real jobs still count as three, and stop the update", () => {
    const p = (pid: number, pgid: number) => ({
      pid,
      ppid: 1,
      pgid,
      args: "bun scripts/verify.ts",
    });
    expect(countHeavyJobs([p(1, 10), p(2, 20), p(3, 30)], 0)).toBe(3);
  });
  test("R851: a held lock is a job even when no process names one", () => {
    expect(countHeavyJobs([], 3)).toBe(3);
    expect(countHeavyJobs([{ pid: 1, ppid: 1, pgid: 1, args: "sleep 100" }], 2)).toBe(2);
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

  test("R777: a stale .gated is re-gated at the script's commit first; on a failing re-gate the kept build is still judged there", async () => {
    const stale = { [GATED_COMMIT]: V3_GATE_LEGS.filter((l) => l !== "O1") };
    await setupKept();
    const a = rj({ legsByCommit: stale, realSha: true, seq: ["pass", "gate-fail"] });
    expect(await edgeRejudge(a.deps, EDGE)).toBe("gate-fail");
    expect(a.seen.gates).toEqual([FIXED_COMMIT, FIXED_COMMIT]);
    await setupKept();
    const before = await tree();
    const b = rj({ legsByCommit: stale, realSha: true, seq: ["gate-fail", "gate-fail"] });
    expect(await edgeRejudge(b.deps, EDGE)).toBe("gate-fail");
    expect(b.seen.gates).toEqual([FIXED_COMMIT, FIXED_COMMIT]);
    expect(b.seen.envs[1]?.LETHAL_ALRUNNER_V3_PATH).toBe(join(kept(), "al-runner"));
    const after = await tree();
    for (const [p, bytes] of Object.entries(before)) expect(after[p]).toBe(bytes);
    expect(JSON.parse(await readFile(join(await current(), ".gated"), "utf8")).lethalCommit).toBe(
      GATED_COMMIT,
    );
  });

  test("R777: a rejudge the cheap checks refuse spends no re-gate", async () => {
    await setup();
    const { deps, seen } = rj({ legsByCommit: { [GATED_COMMIT]: ["C"] } });
    await expect(edgeRejudge(deps, EDGE)).rejects.toThrow(/no kept binary/);
    expect(seen.gates).toEqual([]);
  });
});

// R777: a candidate is never judged on fewer legs than this script's V3_GATE_LEGS.
linuxOnly("R777: .gated's commit predates a leg", () => {
  const STALE = { [GATED_COMMIT]: V3_GATE_LEGS.filter((l) => l !== "O1" && l !== "N1S") };
  const gatedCommit = async () =>
    JSON.parse(await readFile(join(await current(), ".gated"), "utf8")).lethalCommit;

  test("alpha: current is re-gated at the script's commit, then the candidate is judged there", async () => {
    await setup();
    const { deps, seen } = fake({
      legsByCommit: STALE,
      realSha: true,
      outcome: "pass",
      tags: ["v3.0.0-alpha.4"],
    });
    expect(await updateOnce(deps)).toEqual(["pass"]);
    expect(seen.gates).toEqual([FIXED_COMMIT, FIXED_COMMIT]);
    expect(seen.envs[0]?.LETHAL_ALRUNNER_V3_CANDIDATE).toBeUndefined();
    expect(seen.envs[1]?.LETHAL_ALRUNNER_V3_CANDIDATE).toBe("1");
    await releaseOnlyInstalled("3.0.0-alpha.4-c893e3633");
    expect(await gatedCommit()).toBe(FIXED_COMMIT);
    expect(existsSync(join(root, "regate", `${FIXED_COMMIT}.receipt.json`))).toBe(true);
    expect(seen.logs.join("\n")).toContain(
      `alpha: stale-gated: .gated's lethalCommit ${GATED_COMMIT} predates leg(s) N1S,O1 of V3_GATE_LEGS; re-gating current at ${FIXED_COMMIT} first`,
    );
  });

  test("alpha: a failing re-gate leaves current; the candidate is still judged at the script's commit", async () => {
    await setup();
    const a = fake({ legsByCommit: STALE, realSha: true, seq: ["gate-fail", "gate-fail"] });
    expect(await updateOnce(a.deps)).toEqual(["gate-fail"]);
    expect(a.seen.gates).toEqual([FIXED_COMMIT, FIXED_COMMIT]);
    expect(await current()).toBe(join(root, "3.0.0-alpha.2-91253f2d6"));
    expect(await gatedCommit()).toBe(GATED_COMMIT);
    expect(existsSync(join(failedAt("v3.0.0-alpha.3", FIXED_COMMIT), "al-runner"))).toBe(true);
    expect(a.seen.logs.join("\n")).toContain(
      `the re-gate of current at ${FIXED_COMMIT} gave gate-fail: current stays at ${GATED_COMMIT}; the candidate is judged at ${FIXED_COMMIT}`,
    );
    await setup();
    const b = fake({ legsByCommit: STALE, realSha: true, seq: ["gate-fail", "pass"] });
    expect(await updateOnce(b.deps)).toEqual(["pass"]);
    await releaseOnlyInstalled(ALPHA3_DIR);
    expect(await gatedCommit()).toBe(GATED_COMMIT);
  });

  test("the script's commit cannot serve (lacks the legs, off origin/master, or not newer): nothing is gated", async () => {
    const cases: [Parameters<typeof fake>[0], string][] = [
      [{ legsByCommit: { ...STALE, [FIXED_COMMIT]: STALE[GATED_COMMIT] ?? [] } }, "lacks them too"],
      [{ legsByCommit: STALE, ancestor: () => false }, "is not on origin/master"],
      [{ legsByCommit: STALE, ancestor: () => true }, "is not newer than .gated's"],
    ];
    for (const [o, why] of cases) {
      await setup();
      const { deps, seen } = fake({ ...o, outcome: "pass" });
      expect(await updateOnce(deps)).toEqual(["skipped"]);
      expect(seen.gates).toEqual([]);
      expect(seen.logs.join("\n")).toContain(`this script's commit ${FIXED_COMMIT} ${why}`);
    }
  });

  test("not stale: a receipt missing a leg the gated commit itself has is still infra-fail, with no re-gate", async () => {
    await setup();
    const legs = Object.fromEntries(V3_GATE_LEGS.filter((l) => l !== "T").map((l) => [l, "pass"]));
    const { deps, seen } = fake({ outcome: "pass", legs, tags: ["v3.0.0-alpha.3"] });
    expect(await updateOnce(deps)).toEqual(["infra-fail"]);
    expect(seen.gates).toEqual([GATED_COMMIT]);
    expect(seen.logs.join("\n")).not.toContain("stale-gated");
  });

  test("edge: re-gated first, then gated; when the script's commit cannot serve, skipped and edge.last-seen left alone", async () => {
    const edgeDeps = (o: Parameters<typeof fake>[0]) => {
      const f = fake(o);
      return { ...f, deps: { ...f.deps, edgeCommit: async () => "c893e3633" } };
    };
    await setup();
    const a = edgeDeps({ legsByCommit: STALE, realSha: true, outcome: "pass" });
    expect(await edgeOnce(a.deps)).toBe("pass");
    expect(a.seen.gates).toEqual([FIXED_COMMIT, FIXED_COMMIT]);
    await setup();
    const b = edgeDeps({ legsByCommit: STALE, ancestor: () => false, outcome: "pass" });
    expect(await edgeOnce(b.deps)).toBe("skipped");
    expect(b.seen.gates).toEqual([]);
    expect(existsSync(join(root, "edge.last-seen"))).toBe(false);
  });
});

describe("R777: parseGateLegs", () => {
  test("reads the real gate module's V3_GATE_LEGS; a module without it throws", async () => {
    const src = await readFile(
      join(import.meta.dir, "../packages/runner/itest/al-runner-v3-gate.ts"),
      "utf8",
    );
    expect(parseGateLegs(src)).toEqual([...V3_GATE_LEGS]);
    expect(
      parseGateLegs('export const V3_GATE_LEGS = [\n  "C", // a [note] "K"\n  "T",\n] as const;'),
    ).toEqual(["C", "T"]);
    expect(() => parseGateLegs("export const OTHER = [];")).toThrow(/V3_GATE_LEGS/);
  });

  test("the real git reads: HEAD's legs are V3_GATE_LEGS, HEAD is a full sha and its own ancestor", async () => {
    const d = realDeps(join(tmpdir(), "lethal-r777-unused"));
    const head = await d.selfCommit();
    expect(head).toMatch(/^[0-9a-f]{40}$/);
    expect(await d.legsAt(head)).toEqual([...V3_GATE_LEGS]);
    expect(await d.isAncestor(head, head)).toBe(true);
  });
});

// R813/R814: edge moves `current`; a release only joins the manifest; a mechanical pin.
linuxOnly("R814: the two tracks", () => {
  const ROOT_PIN = "alpha.12-d4bc8d3a5";
  const REL = "v3.0.0-alpha.3";
  const TAGS = ["edge", REL, "v3.0.0-alpha.2"];
  /** `current` as a mechanical build: its `.gated` names the hand pin. */
  async function setupPinned(): Promise<void> {
    await setup();
    const f = join(await current(), ".gated");
    const g = JSON.parse(await readFile(f, "utf8"));
    await writeFile(f, JSON.stringify({ ...g, readingsFrom: ROOT_PIN }));
  }
  const gatedOf = async (dir: string) =>
    JSON.parse(await readFile(join(root, dir, ".gated"), "utf8"));
  const ledger = async () =>
    existsSync(join(root, "gated-builds.jsonl"))
      ? (await readFile(join(root, "gated-builds.jsonl"), "utf8"))
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l))
      : [];
  const pinnedPass = { outcome: "pass", pinApplied: ROOT_PIN } as const;

  test("daily: edge first and it moves current; the release then passes and does NOT move it", async () => {
    await setupPinned();
    const { deps, seen } = edgeOf({ ...pinnedPass, tags: TAGS });
    expect(await dailyOnce(deps)).toEqual({ edge: "pass", releases: ["pass"] });
    expect(seen.tagsGated).toEqual(["edge-c893e3633", REL]);
    expect(await current()).toBe(join(root, EDGE_DIR));
    expect((await ledger()).map((r) => r.track)).toEqual(["edge", "release"]);
    expect(seen.published).toEqual(["edge-c893e3633", "alpha.3-c893e3633"]);
  });

  test("daily: a release gate-fail or held leaves current and the manifest alone", async () => {
    for (const bad of ["gate-fail", "held"] as const) {
      await setupPinned();
      const { deps, seen } = edgeOf({
        pinApplied: ROOT_PIN,
        tags: TAGS,
        byTag: { "edge-c893e3633": "pass", [REL]: bad },
      });
      expect(await dailyOnce(deps)).toEqual({ edge: "pass", releases: [bad] });
      expect(await current()).toBe(join(root, EDGE_DIR));
      expect((await ledger()).map((r) => r.id)).toEqual(["edge-c893e3633"]);
      expect(seen.published).toEqual(["edge-c893e3633"]);
    }
  });

  test("a release never moves current, even with no edge run at all", async () => {
    await setupPinned();
    const { deps } = fake({ ...pinnedPass, tags: TAGS });
    expect(await updateOnce(deps)).toEqual(["pass"]);
    await releaseOnlyInstalled(ALPHA3_DIR);
    const [r] = await ledger();
    expect(r).toMatchObject({ track: "release", tag: REL, id: "alpha.3-c893e3633" });
  });

  test("order: ahead and identical move current; behind and diverged do not gate at all", async () => {
    for (const order of ["ahead", "identical"] as const) {
      await setupPinned();
      expect(await edgeOnce(edgeOf({ ...pinnedPass, order }).deps)).toBe("pass");
      expect(await current()).toBe(join(root, EDGE_DIR));
    }
    for (const order of ["behind", "diverged"] as const) {
      await setupPinned();
      const { deps, seen } = edgeOf({ ...pinnedPass, order });
      expect(await edgeOnce(deps)).toBe("skipped");
      expect(seen.gates).toEqual([]);
      expect(await current()).toBe(join(root, ALPHA2_DIR));
      expect(existsSync(join(root, "edge.last-seen"))).toBe(false);
      expect(seen.logs.join("\n")).toContain("current never moves backwards");
    }
  });

  test("order: a compare that fails is infra-fail, never ahead", async () => {
    await setupPinned();
    const { deps, seen } = edgeOf({ ...pinnedPass, orderThrows: true });
    expect(await edgeOnce(deps)).toBe("infra-fail");
    expect(seen.gates).toEqual([]);
    expect(await current()).toBe(join(root, ALPHA2_DIR));
  });

  test("a release is never order-checked: it cannot move current", async () => {
    await setupPinned();
    const { deps } = fake({ ...pinnedPass, order: "behind", tags: TAGS });
    expect(await updateOnce(deps)).toEqual(["pass"]);
  });

  test("the pin: a candidate is judged by current's root, with K; no pin, no env", async () => {
    await setupPinned();
    const a = edgeOf(pinnedPass);
    await edgeOnce(a.deps);
    expect(a.seen.envs[0]?.LETHAL_V3_PIN_FROM).toBe(ROOT_PIN);
    expect(a.seen.envs[0]?.LETHAL_ITEST_V3_K_ON_CANDIDATE).toBe("1");
    await setup();
    const b = edgeOf({ outcome: "pass" });
    await edgeOnce(b.deps);
    expect(b.seen.envs[0]?.LETHAL_V3_PIN_FROM).toBeUndefined();
  });

  test("the pin: --regate sets neither env, and carries a mechanical build's readingsFrom", async () => {
    await setupPinned();
    const { deps, seen } = fake({ outcome: "pass", receiptSha: sha("alpha2") });
    expect(await updateOnce(deps, { regateAt: REGATE_COMMIT })).toEqual(["pass"]);
    expect(seen.envs[0]?.LETHAL_V3_PIN_FROM).toBeUndefined();
    expect(seen.envs[0]?.LETHAL_ITEST_V3_K_ON_CANDIDATE).toBeUndefined();
    expect((await gatedOf(ALPHA2_DIR)).readingsFrom).toBe(ROOT_PIN);
  });

  test("a pass writes readingsFrom and a ledger row with the hand pin's digest; a held row writes neither", async () => {
    await setupPinned();
    await edgeOnce(edgeOf(pinnedPass).deps);
    expect((await gatedOf(EDGE_DIR)).readingsFrom).toBe(ROOT_PIN);
    const hand = V3_BUILD_PINS.find((p) => p.id === ROOT_PIN);
    const [r] = await ledger();
    expect(r.readingsFrom).toBe(ROOT_PIN);
    expect(hand !== undefined && r.readingsDigest === v3ReadingsDigest(hand)).toBe(true);
    await setupPinned();
    await edgeOnce(edgeOf({ outcome: "held", pinApplied: ROOT_PIN }).deps);
    expect(await ledger()).toEqual([]);
    expect(await current()).toBe(join(root, ALPHA2_DIR));
  });

  test("a pass that applied no pin, asked for one, is infra-fail: current stays, no row", async () => {
    await setupPinned();
    const { deps, seen } = edgeOf({ outcome: "pass" });
    expect(await edgeOnce(deps)).toBe("infra-fail");
    expect(await current()).toBe(join(root, ALPHA2_DIR));
    expect(await ledger()).toEqual([]);
    expect(seen.logs.join("\n")).toContain("applied no pin");
  });

  test("K that ran and failed is a verdict: gate-fail lands in failed/, held in held/, and edge is seen", async () => {
    await setupPinned();
    const legs = { ...legsFor("pass"), K: "gate-fail" } as Record<string, string>;
    expect(await edgeOnce(edgeOf({ ...pinnedPass, legs }).deps)).toBe("gate-fail");
    expect(await current()).toBe(join(root, ALPHA2_DIR));
    expect(existsSync(failedAt("edge-c893e3633"))).toBe(true);
    expect(existsSync(join(root, "edge.last-seen"))).toBe(true);
    await setupPinned();
    const held = { ...legsFor("pass"), K: "held" } as Record<string, string>;
    expect(await edgeOnce(edgeOf({ ...pinnedPass, legs: held }).deps)).toBe("held");
    expect(existsSync(join(root, "held", "edge-c893e3633"))).toBe(true);
  });

  test("a gate that judged by another version of the pin is infra-fail: no row, current stays", async () => {
    await setupPinned();
    const { deps, seen } = edgeOf({ ...pinnedPass, pinDigest: sha("an older pin") });
    expect(await edgeOnce(deps)).toBe("infra-fail");
    expect(await current()).toBe(join(root, ALPHA2_DIR));
    expect(await ledger()).toEqual([]);
    expect(seen.logs.join("\n")).toContain("re-gate current first");
  });

  test("a pin file that moved since .gated's commit re-gates current first", async () => {
    await setupPinned();
    const { deps, seen } = edgeOf({
      ...pinnedPass,
      pinsMovedAt: [GATED_COMMIT],
      realSha: true,
    });
    expect(await edgeOnce(deps)).toBe("pass");
    expect(seen.gates).toEqual([FIXED_COMMIT, FIXED_COMMIT]);
    expect(seen.logs.join("\n")).toContain("al-runner-v3-pins.ts");
  });

  test("daily: edge throwing does not stop the release track or the rows of what passed", async () => {
    await setupPinned();
    const f = fake({ ...pinnedPass, tags: TAGS });
    const deps = {
      ...f.deps,
      edgeCommit: async () => {
        throw new Error("gh is down");
      },
    };
    expect(await dailyOnce(deps)).toEqual({ edge: "infra-fail", releases: ["pass"] });
    expect(f.seen.published).toEqual(["alpha.3-c893e3633"]);
    expect(f.seen.logs.join("\n")).toContain("the edge track failed");
  });

  test("the ledger: a torn line is logged and skipped; a repeated id goes once", async () => {
    await setupPinned();
    const r = JSON.stringify({ id: "edge-x", track: "edge" });
    await writeFile(join(root, "gated-builds.jsonl"), `${r}\n{"id":"to\n${r}\n`);
    const { deps, seen } = edgeOf({ tags: ["edge"] });
    await publishPending(deps);
    expect(seen.published).toEqual(["edge-x"]);
    expect(seen.logs.join("\n")).toContain("an unreadable line skipped");
  });

  test("a candidate's pass with K not passed is infra-fail", async () => {
    for (const K of ["skipped (candidate build)", undefined]) {
      await setupPinned();
      const legs = { ...legsFor("pass"), K } as Record<string, string>;
      const { deps } = edgeOf({ ...pinnedPass, legs });
      expect(await edgeOnce(deps)).toBe("infra-fail");
      expect(await current()).toBe(join(root, ALPHA2_DIR));
    }
  });

  test("a gate commit that ignores the pin is re-gated first, never judged unpinned", async () => {
    await setupPinned();
    const { deps, seen } = edgeOf({
      ...pinnedPass,
      noPinFromAt: [GATED_COMMIT],
      realSha: true,
    });
    expect(await edgeOnce(deps)).toBe("pass");
    expect(seen.gates).toEqual([FIXED_COMMIT, FIXED_COMMIT]);
    expect(seen.logs.join("\n")).toContain("LETHAL_V3_PIN_FROM");
  });

  test("publish: each id once, so a row a person recalled is not put back; a refused row stays pending", async () => {
    await setupPinned();
    const pushed: string[][] = [];
    const a = edgeOf({
      ...pinnedPass,
      tags: ["edge"],
      publish: async (e) => {
        pushed.push(e.map((x) => x.id));
        return { published: e.map((x) => x.id), refused: [] };
      },
    });
    await dailyOnce(a.deps);
    await publishPending(a.deps);
    expect(pushed).toEqual([["edge-c893e3633"]]);

    await setupPinned();
    let calls = 0;
    const b = edgeOf({
      ...pinnedPass,
      publish: async (e) => {
        calls++;
        return { published: [], refused: e.map((x) => ({ id: x.id, why: "no such pin" })) };
      },
    });
    await dailyOnce(b.deps);
    await publishPending(b.deps);
    expect(calls).toBe(2);
    expect(b.seen.logs.join("\n")).toContain("REFUSED: no such pin");
  });

  test("publish: a failure is logged and does not stop current moving; the next run retries", async () => {
    await setupPinned();
    let fail = true;
    const { deps, seen } = edgeOf({
      ...pinnedPass,
      tags: ["edge"],
      publish: async (e) => {
        if (fail) throw new Error("rejected");
        return { published: e.map((x) => x.id), refused: [] };
      },
    });
    await dailyOnce(deps);
    expect(await current()).toBe(join(root, EDGE_DIR));
    expect(seen.logs.join("\n")).toContain("next run retries");
    fail = false;
    await publishPending(deps);
    expect(await readFile(join(root, "gated-builds.published"), "utf8")).toBe("edge-c893e3633\n");
  });

  test("release candidates count the ledger too: a passed release is not re-gated", async () => {
    await setupPinned();
    const first = fake({ ...pinnedPass, tags: TAGS });
    await updateOnce(first.deps);
    const again = fake({ ...pinnedPass, tags: TAGS });
    expect(await updateOnce(again.deps)).toEqual([]);
    expect(again.seen.gates).toEqual([]);
  });

  test("heavy limits are read before each release gate, not once", async () => {
    await setupPinned();
    const { deps, seen } = fake({
      pinApplied: ROOT_PIN,
      outcome: "gate-fail",
      tags: ["v3.0.0-alpha.4", REL],
    });
    let n = 0;
    deps.heavyJobs = async () => (n++ === 0 ? 0 : 3);
    expect(await updateOnce(deps)).toEqual(["gate-fail", "skipped"]);
    expect(seen.gates).toHaveLength(1);
  });

  test("a v3 tag the script cannot read is logged, not silently dropped", async () => {
    await setupPinned();
    const { deps, seen } = fake({ ...pinnedPass, tags: ["v3.0.0-beta.1", "v3.0.0-alpha.2"] });
    expect(await updateOnce(deps)).toEqual([]);
    expect(seen.logs.join("\n")).toContain("v3.0.0-beta.1: a release tag this script cannot read");
  });
});

describe("R814: publishToMaster, on real git repositories", () => {
  /** Master's hand pins, as `--pin-digests` reports them. */
  const digestsOf = async () => ({ "root-pin": sha("d") });
  const row = (id: string, from = "root-pin") => ({
    id,
    track: "edge",
    version: `al-runner 3.0.0 (${id})`,
    binarySha256: sha(id),
    readingsFrom: from,
    readingsDigest: sha("d"),
    lethalCommit: "a".repeat(40),
    gatedAt: "2026-11-05T00:00:00Z",
  });
  const git = (cwd: string, ...a: string[]) => {
    const r = Bun.spawnSync(["git", ...a], { cwd, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr.toString()}`);
    return r.stdout.toString().trim();
  };
  let top = "";
  afterEach(async () => {
    if (top !== "") await rm(top, { recursive: true, force: true });
    top = "";
  });
  /** A bare origin with master, the data file and a pin file; a clone; and the worktree path. */
  async function repos() {
    top = await mkdtemp(join(tmpdir(), "lethal-r814-git-"));
    const origin = join(top, "origin.git");
    const clone = join(top, "clone");
    git(top, "init", "-q", "--bare", "-b", "master", origin);
    git(top, "clone", "-q", origin, clone);
    git(clone, "config", "user.email", "t@example.invalid");
    git(clone, "config", "user.name", "t");
    await mkdir(dirname(join(clone, GATED_BUILDS_FILE)), { recursive: true });
    await writeFile(join(clone, GATED_BUILDS_FILE), "[]\n");
    await writeFile(
      join(clone, "packages/runner/src/al-runner-v3-pins.ts"),
      '  {\n    id: "root-pin",\n  },\n',
    );
    git(clone, "add", ".");
    git(clone, "commit", "-q", "-m", "init");
    git(clone, "branch", "-M", "master");
    git(clone, "push", "-q", "origin", "master");
    return { origin, clone, worktree: join(top, "pins") };
  }
  const onMaster = (clone: string) => {
    git(clone, "fetch", "-q", "origin");
    return JSON.parse(git(clone, "show", `origin/master:${GATED_BUILDS_FILE}`)).map(
      (e: { id: string }) => e.id,
    );
  };

  test("adds the row in one [skip ci] commit touching only the file; a second run adds nothing", async () => {
    const { clone, worktree } = await repos();
    const e = row("b") as unknown as GatedBuildEntry;
    const o = { repo: clone, worktree, digestsOf };
    expect(await publishToMaster([e], o)).toEqual({ published: ["b"], refused: [] });
    expect(onMaster(clone)).toEqual(["b"]);
    expect(git(clone, "log", "-1", "--format=%s", "origin/master")).toContain("[skip ci]");
    expect(git(clone, "show", "--name-only", "--format=", "origin/master")).toBe(GATED_BUILDS_FILE);
    const head = git(clone, "rev-parse", "origin/master");
    expect(await publishToMaster([e], o)).toEqual({ published: ["b"], refused: [] });
    git(clone, "fetch", "-q", "origin");
    expect(git(clone, "rev-parse", "origin/master")).toBe(head);
  });

  test("a row whose hand pin is not on MASTER is refused alone; the good row still lands, sorted", async () => {
    const { clone, worktree } = await repos();
    const bad = row("a", "unmerged-pin") as unknown as GatedBuildEntry;
    const good = row("b") as unknown as GatedBuildEntry;
    const r = await publishToMaster([bad, good], { repo: clone, worktree, digestsOf });
    expect(r.published).toEqual(["b"]);
    expect(r.refused.map((x) => x.id)).toEqual(["a"]);
    expect(r.refused[0]?.why).toContain("is no hand pin");
    expect(onMaster(clone)).toEqual(["b"]);
  });

  test("a row gated by a pin that differs on master is refused alone, so master's test stays green", async () => {
    const { clone, worktree } = await repos();
    const stale = {
      ...row("a"),
      readingsDigest: sha("an older pin"),
    } as unknown as GatedBuildEntry;
    const good = row("b") as unknown as GatedBuildEntry;
    const r = await publishToMaster([stale, good], { repo: clone, worktree, digestsOf });
    expect(r.published).toEqual(["b"]);
    expect(r.refused[0]?.why).toContain("is not the pin a was gated by");
    expect(onMaster(clone)).toEqual(["b"]);
  });

  test("--pin-digests prints every hand pin's digest, this checkout's", () => {
    const p = Bun.spawnSync(["bun", "scripts/al-runner-v3-update.ts", "--pin-digests"], {
      cwd: dirname(import.meta.dir),
      stdout: "pipe",
    });
    expect(p.exitCode).toBe(0);
    expect(JSON.parse(p.stdout.toString())).toEqual(pinDigests());
  });

  /** Origin refuses a push while its counter is under `rejects`; the file holds the tries seen. */
  async function rejectPushes(origin: string, rejects: number): Promise<string> {
    const count = join(top, "pushes");
    await writeFile(count, "0");
    const hook = join(origin, "hooks", "pre-receive");
    await writeFile(
      hook,
      `#!/bin/sh\nn=$(cat "${count}")\necho $((n + 1)) > "${count}"\n[ "$n" -ge ${rejects} ]\n`,
    );
    await chmod(hook, 0o755);
    return count;
  }

  test("a rejected push fetches again and retries, and the row lands", async () => {
    const { origin, clone, worktree } = await repos();
    const count = await rejectPushes(origin, 2);
    const r = await publishToMaster([row("b") as unknown as GatedBuildEntry], {
      repo: clone,
      worktree,
      digestsOf,
    });
    expect(r.published).toEqual(["b"]);
    expect(onMaster(clone)).toEqual(["b"]);
    expect((await readFile(count, "utf8")).trim()).toBe("3");
  });

  test("three rejected pushes throw, so the next run retries; nothing lands", async () => {
    const { origin, clone, worktree } = await repos();
    const count = await rejectPushes(origin, 99);
    await expect(
      publishToMaster([row("b") as unknown as GatedBuildEntry], {
        repo: clone,
        worktree,
        digestsOf,
      }),
    ).rejects.toThrow();
    expect((await readFile(count, "utf8")).trim()).toBe("3");
    expect(onMaster(clone)).toEqual([]);
  });

  test("a lane's commit already on master is built on, never overwritten", async () => {
    const { clone, worktree } = await repos();
    await publishToMaster([row("b") as unknown as GatedBuildEntry], {
      repo: clone,
      worktree,
      digestsOf,
    });
    const other = join(top, "other");
    git(top, "clone", "-q", join(top, "origin.git"), other);
    git(other, "config", "user.email", "t@example.invalid");
    git(other, "config", "user.name", "t");
    await writeFile(join(other, "lane.txt"), "a lane's commit");
    git(other, "add", ".");
    git(other, "commit", "-q", "-m", "lane");
    git(other, "push", "-q", "origin", "HEAD:master");
    const laneHead = git(other, "rev-parse", "HEAD");
    await publishToMaster([row("c") as unknown as GatedBuildEntry], {
      repo: clone,
      worktree,
      digestsOf,
    });
    git(clone, "fetch", "-q", "origin");
    expect(git(clone, "merge-base", "--is-ancestor", laneHead, "origin/master")).toBe("");
    expect(onMaster(clone)).toEqual(["b", "c"]);
  });
});

describe("R814: pinFromAt", () => {
  test("the literal it looks for is in the pin module", async () => {
    const src = await readFile(
      join(import.meta.dir, "../packages/runner/src/al-runner-v3-pin.ts"),
      "utf8",
    );
    expect(src).toContain('export const V3_PIN_FROM_ENV = "LETHAL_V3_PIN_FROM"');
  });
});
