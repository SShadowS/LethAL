// R586 T19 (plan r2 §12, r3 F6, r4 I-3): the v3 update gate with fakes, every outcome both ways.
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { dirname, join } from "node:path";
import { V3_GATE_LEGS } from "../packages/runner/itest/al-runner-v3-gate";
import { V3_CAPABILITY_FACTS } from "../packages/runner/src/al-runner-v3-contract";
import { checkGated, parseGated } from "../packages/runner/src/al-runner-v3-pin";
import {
  type GatedBuildEntry,
  V3_BUILD_PINS,
  v3ReadingsDigest,
} from "../packages/runner/src/al-runner-v3-pins";
import {
  type CommitOrder,
  GATED_BUILDS_FILE,
  GATE_STEPS,
  GATE_WORKTREE,
  HEAVY_JOB,
  type Outcome,
  type PublishResult,
  ROOT,
  type UpdateDeps,
  type UpdateHandlers,
  V3_CDO_DEFAULT,
  argv0FromCmdline,
  batchingRecordLine,
  candidates,
  checkPrivateRoot,
  copyCacheTree,
  countHeavyJobs,
  dailyOnce,
  dispatchUpdate,
  edgeOnce,
  edgeRejudge,
  expectedSha,
  gateOne,
  isUnderRoot,
  movesUnder,
  parseGateLegs,
  parseUpdateArgs,
  pinDigests,
  privateGateOnce,
  privateRealDeps,
  publishPending,
  publishToMaster,
  readReceipt,
  realDeps,
  refreshRows,
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
  /** PR-117: the receipt's leg C capability readings and whether DBM batched (the update script reads both with `legs.DBM`). */
  batchFacts?: Record<string, string>;
  dbmBatched?: boolean;
  heavy?: number;
  free?: number;
  /** R952: the memory rule's answer for the gate; "no-limit" answers undefined (no cgroup limit). Absent: no such dep. */
  mem?: { refuse: boolean; message: string } | "no-limit";
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
    ...(o.mem !== undefined
      ? { gateMemory: async () => (o.mem === "no-limit" ? undefined : o.mem) }
      : {}),
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
          ...(o.batchFacts !== undefined ? { batchFacts: o.batchFacts } : {}),
          ...(o.dbmBatched === true ? { dbmBatched: true } : {}),
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

  describe("PR-117: batchFacts are recorded only from a gate that proved batching", () => {
    const ALL = Object.fromEntries(V3_CAPABILITY_FACTS.map((n) => [n, "matches"]));
    const withDbm = (dbm: string | undefined) => {
      const { DBM: _d, ...rest } = legsFor("pass");
      return dbm === undefined ? rest : { ...rest, DBM: dbm };
    };
    const gatedOf = async () =>
      JSON.parse(await readFile(join(root, ALPHA3_DIR, ".gated"), "utf8"));

    test("a receipt with legs.DBM pass and dbmBatched writes batchFacts into .gated", async () => {
      await setup();
      const { deps } = fake({
        outcome: "pass",
        batchFacts: ALL,
        dbmBatched: true,
        legs: withDbm("pass"),
      });
      expect(await updateOnce(deps)).toEqual(["pass"]);
      expect((await gatedOf()).batchFacts).toEqual(ALL);
    });

    test("none written when DBM is not pass, is absent, or did not batch", async () => {
      for (const o of [
        { dbm: "gate-fail", batched: true },
        { dbm: "infra-fail", batched: true },
        { dbm: undefined, batched: true },
        { dbm: "pass", batched: false },
      ]) {
        await setup();
        const { deps } = fake({
          outcome: "pass",
          batchFacts: ALL,
          dbmBatched: o.batched,
          legs: withDbm(o.dbm),
        });
        expect(await updateOnce(deps)).toEqual(["pass"]);
        expect("batchFacts" in (await gatedOf()), JSON.stringify(o)).toBe(false);
      }
    });

    test("the update log says whether the record allows batching, both ways", async () => {
      await setup();
      const yes = fake({
        outcome: "pass",
        batchFacts: ALL,
        dbmBatched: true,
        legs: withDbm("pass"),
        pinApplied: "edge-d72d3197d",
      });
      await updateOnce(yes.deps);
      expect(yes.seen.logs.join("\n")).toContain("gate record allows baseline batching");
      await setup();
      const no = fake({ outcome: "pass", legs: withDbm("pass") });
      await updateOnce(no.deps);
      expect(no.seen.logs.join("\n")).toContain(
        "gate record does not allow baseline batching (no batchFacts",
      );
    });

    test("L: a receipt that does not qualify because a capability fact did not read matches names that fact in the log", async () => {
      await setup();
      const bad = { ...ALL, "batch-lane-hint-only": "diverged" };
      const f = fake({ outcome: "pass", batchFacts: bad, legs: withDbm("pass") });
      await updateOnce(f.deps);
      expect(f.seen.logs.join("\n")).toContain(
        "gate record does not allow baseline batching (the gate read batch-lane-hint-only diverged)",
      );
      expect("batchFacts" in (await gatedOf())).toBe(false);
      expect(batchingRecordLine(undefined, true, ALL)).toContain("no batchFacts");
    });

    test("batchingRecordLine: each reason by name; the pin half of the Sleep rule", () => {
      expect(batchingRecordLine(ALL, true)).toBe("gate record allows baseline batching");
      expect(batchingRecordLine(ALL, false)).toMatch(/does not allow .*sleep-is-noop/);
      expect(batchingRecordLine({ ...ALL, "batch-lane-hint-only": "diverged" }, true)).toContain(
        "the gate read batch-lane-hint-only diverged",
      );
      const { "batch-no-cross-row": _x, ...rest } = ALL;
      expect(batchingRecordLine(rest, true)).toContain("batch-no-cross-row not recorded");
    });

    test("a --regate whose receipt does not qualify writes none, although the old .gated had them", async () => {
      await setup();
      const gatedFile = join(await current(), ".gated");
      const old = JSON.parse(await readFile(gatedFile, "utf8"));
      await writeFile(gatedFile, JSON.stringify({ ...old, batchFacts: ALL }));
      const { deps } = fake({ outcome: "pass", receiptSha: sha("alpha2"), legs: withDbm("pass") });
      deps.versionOf = async () => "alrunner 3.0.0-alpha.2 (91253f2d6)";
      expect(await updateOnce(deps, { regateAt: REGATE_COMMIT })).toEqual(["pass"]);
      const g = JSON.parse(await readFile(gatedFile, "utf8"));
      expect(g.lethalCommit).toBe(REGATE_COMMIT);
      expect("batchFacts" in g).toBe(false);
    });

    test("a --regate whose receipt qualifies writes this gate's batchFacts", async () => {
      await setup();
      const { deps } = fake({
        outcome: "pass",
        receiptSha: sha("alpha2"),
        batchFacts: ALL,
        dbmBatched: true,
        legs: withDbm("pass"),
      });
      deps.versionOf = async () => "alrunner 3.0.0-alpha.2 (91253f2d6)";
      expect(await updateOnce(deps, { regateAt: REGATE_COMMIT })).toEqual(["pass"]);
      const g = JSON.parse(await readFile(join(await current(), ".gated"), "utf8"));
      expect(g.batchFacts).toEqual(ALL);
    });
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

  // R-996: the upstream repro report, for a new candidate only, against the current pin, never a verdict.
  describe("R-996: the upstream repros run on each new candidate", () => {
    const withRepros = <D extends UpdateDeps>(
      deps: D,
      calls: string[][],
      lines: string[] | Error,
    ): D => ({
      ...deps,
      upstreamRepros: async (candidate: string, cur: string) => {
        calls.push([candidate, cur]);
        if (lines instanceof Error) throw lines;
        return lines;
      },
    });
    for (const outcome of ["pass", "gate-fail"] as const) {
      test(`an edge candidate (${outcome}): run on the candidate binary against current's, and every line logged`, async () => {
        await setup();
        const cur = join(await current(), "al-runner");
        const calls: string[][] = [];
        const { deps, seen } = edgeOf({ outcome });
        const r = await edgeOnce(
          withRepros(deps, calls, ["FLIPPED to BC: r1 T: re-run DO", "upstream repros: 1 test(s)"]),
        );
        expect(r).toBe(outcome);
        expect(calls).toHaveLength(1);
        expect(calls[0]?.[1]).toBe(cur);
        expect(calls[0]?.[0]).not.toBe(cur);
        expect(seen.logs.some((l) => l.endsWith("FLIPPED to BC: r1 T: re-run DO"))).toBe(true);
      });
    }
    test("a failing repro run is logged and changes no verdict", async () => {
      await setup();
      const calls: string[][] = [];
      const { deps, seen } = edgeOf({ outcome: "pass" });
      expect(await edgeOnce(withRepros(deps, calls, new Error("boom")))).toBe("pass");
      expect(seen.logs.some((l) => l.includes("upstream repros not run: Error: boom"))).toBe(true);
    });
    test("not on --regate (no new build) and not on an infra-fail", async () => {
      await setup();
      const calls: string[][] = [];
      const re = fake({ outcome: "pass", receiptSha: sha("alpha2") });
      re.deps.versionOf = async () => "alrunner 3.0.0-alpha.2 (91253f2d6)";
      await updateOnce(withRepros(re.deps, calls, []), { regateAt: REGATE_COMMIT });
      expect(calls).toEqual([]);
      await setup();
      const inf = edgeOf({ outcome: "infra-fail" });
      await edgeOnce(withRepros(inf.deps, calls, []));
      expect(calls).toEqual([]);
    });
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

  test("R1017: --regate of a current that has a sidecar gates a copy that cannot see it, with current's .gated beside it", async () => {
    await setup();
    const cur = await current();
    await mkdir(join(cur, "dotnet-sidecar"), { recursive: true });
    await writeFile(join(cur, "dotnet-sidecar", "AlDotNetSidecar.dll"), "dll");
    const f = fake({ outcome: "pass", receiptSha: sha("alpha2") });
    f.deps.versionOf = async () => "alrunner 3.0.0-alpha.2 (91253f2d6)";
    const seenAtGate: { sidecar: boolean; gated: string | undefined; bytes: string }[] = [];
    const deps = {
      ...f.deps,
      runGate: async (
        c: string,
        env: Readonly<Record<string, string>>,
        log: (l: string) => Promise<void>,
      ) => {
        const p = env.LETHAL_ALRUNNER_V3_PATH ?? "";
        const g = join(dirname(p), ".gated");
        seenAtGate.push({
          sidecar: existsSync(join(dirname(p), "dotnet-sidecar")),
          gated: existsSync(g) ? await readFile(g, "utf8") : undefined,
          bytes: await readFile(p, "utf8"),
        });
        return f.deps.runGate(c, env, log);
      },
    };
    const gatedBefore = await readFile(join(cur, ".gated"), "utf8");
    expect(await updateOnce(deps, { regateAt: REGATE_COMMIT })).toEqual(["pass"]);
    expect(seenAtGate).toEqual([
      { sidecar: false, gated: gatedBefore, bytes: await readFile(join(cur, "al-runner"), "utf8") },
    ]);
    // current keeps its sidecar, and its .gated takes the new commit as before.
    expect(existsSync(join(cur, "dotnet-sidecar", "AlDotNetSidecar.dll"))).toBe(true);
    expect(JSON.parse(await readFile(join(cur, ".gated"), "utf8")).lethalCommit).toBe(
      REGATE_COMMIT,
    );
  });

  test("R1017: a binary with no sidecar beside it is gated in place, as before", async () => {
    await setup();
    const f = fake({ outcome: "pass", receiptSha: sha("alpha2") });
    f.deps.versionOf = async () => "alrunner 3.0.0-alpha.2 (91253f2d6)";
    expect(await updateOnce(f.deps, { regateAt: REGATE_COMMIT })).toEqual(["pass"]);
    expect(f.seen.envs[0]?.LETHAL_ALRUNNER_V3_PATH).toBe(join(await current(), "al-runner"));
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

  test("R952: where the cgroup names a limit, the memory rule decides, not the job count", async () => {
    await setup();
    // 3 heavy jobs and 2 GB by free: skipped before; memory admits the gate, so it runs
    const busy = fake({
      outcome: "pass",
      heavy: 3,
      free: 2,
      mem: { refuse: false, message: "admitted" },
    });
    expect(await updateOnce(busy.deps)).toEqual(["pass"]);
    // no heavy job at all, but memory refuses: skipped, and the log names the memory reading
    const full = fake({
      outcome: "pass",
      heavy: 0,
      mem: { refuse: true, message: "memory: max 32.0 GiB ... -> REFUSED (x)" },
    });
    expect(await updateOnce(full.deps)).toEqual(["skipped"]);
    expect(full.seen.gates).toEqual([]);
    expect(full.seen.logs.join("\n")).toContain("skipped for the day: memory: max 32.0 GiB");
    // no cgroup limit to read: the job count decides as before
    const host = fake({ outcome: "pass", heavy: 3, mem: "no-limit" });
    expect(await updateOnce(host.deps)).toEqual(["skipped"]);
    expect(host.seen.logs.join("\n")).toContain("3 heavy jobs are running");
  });

  test("PR-60: under a cgroup limit freeGb is never called; with none it is, and the log says it reads the host", async () => {
    await setup();
    const limited = fake({ outcome: "pass", mem: { refuse: false, message: "admitted" } });
    const boom = async (): Promise<number> => {
      throw new Error("freeGb must not be called under a cgroup limit");
    };
    expect(await updateOnce({ ...limited.deps, freeGb: boom })).toEqual(["pass"]);
    const refused = fake({ outcome: "pass", mem: { refuse: true, message: "memory: REFUSED" } });
    expect(await updateOnce({ ...refused.deps, freeGb: boom })).toEqual(["skipped"]);
    const host = fake({ outcome: "pass", free: 2, mem: "no-limit" });
    expect(await updateOnce(host.deps)).toEqual(["skipped"]);
    expect(host.seen.logs.join("\n")).toContain("reads the host");
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

describe("R950: which running process a move of `current` affects", () => {
  const root = "/work/tools/al-runner-v3";
  const exe = `${root}/edge-42af5d384-42af5d384/al-runner`;
  test("one started through current/ counts; one on an explicit build path does not", () => {
    expect(movesUnder(root, exe, `${root}/current/al-runner`)).toBe(true);
    expect(movesUnder(root, exe, exe)).toBe(false);
    expect(movesUnder(root, exe, `${root}/edge-2bd87774f-2bd87774f/al-runner`)).toBe(false);
  });
  test("the safe side: an unreadable or relative argv[0] counts; a process off root never does", () => {
    expect(movesUnder(root, exe, undefined)).toBe(true);
    expect(movesUnder(root, exe, "al-runner")).toBe(true);
    expect(movesUnder(root, "/usr/bin/bash", `${root}/current/al-runner`)).toBe(false);
  });
  test("a non-normal path through current/ counts (build review r1)", () => {
    for (const a of [
      `${root}//current/al-runner`,
      `${root}/./current/al-runner`,
      `${root}/edge-x/../current/al-runner`,
    ])
      expect(movesUnder(root, exe, a), a).toBe(true);
  });
  test("argv[0] is the cmdline's first NUL-separated field; none when the cmdline is empty", () => {
    expect(argv0FromCmdline(`${root}/current/al-runner\0serve\0--x\0`)).toBe(
      `${root}/current/al-runner`,
    );
    expect(argv0FromCmdline("")).toBeUndefined();
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
  test("R934: a queued heavy-slot.sh --wait waiter is no job; a holding wrapper counts once, by its slot", () => {
    const cmd = "bun packages/runner/src/cli.ts run --project /x";
    const waiter = {
      pid: 1,
      ppid: 0,
      pgid: 1,
      args: `bash scripts/heavy-slot.sh --wait other ${cmd}`,
    };
    const sleeping = { pid: 2, ppid: 1, pgid: 1, args: "sleep 5" };
    expect(countHeavyJobs([waiter, sleeping], 0)).toBe(0);
    const holder = { pid: 3, ppid: 0, pgid: 3, args: `bash scripts/heavy-slot.sh other ${cmd}` };
    const job = { pid: 4, ppid: 3, pgid: 3, args: cmd };
    expect(countHeavyJobs([waiter, sleeping, holder, job], 1)).toBe(1);
  });
  test("R952: a --peak waiter is no job; a job whose argv only mentions heavy-slot.sh is still one", () => {
    const cmd = "bun packages/runner/src/cli.ts run --project /x";
    const waiter = {
      pid: 1,
      ppid: 0,
      pgid: 1,
      args: `bash scripts/heavy-slot.sh --wait --peak gate other ${cmd}`,
    };
    expect(countHeavyJobs([waiter], 0)).toBe(0);
    // the counted direction: a heavy job in its own group naming the wrapper later in its argv
    const mention = {
      pid: 5,
      ppid: 0,
      pgid: 5,
      args: `${cmd} --note scripts/heavy-slot.sh other x`,
    };
    expect(countHeavyJobs([mention], 0)).toBe(1);
  });
  test("R952 review: the Bash tool's shell that launched a queued waiter is no job", () => {
    const cmd = "bun packages/runner/src/cli.ts run --project /x";
    const shell = {
      pid: 1,
      ppid: 0,
      pgid: 1,
      args: `/bin/bash -c source /tmp/snap.sh && eval 'cd /w && bash scripts/heavy-slot.sh --wait other ${cmd}'`,
    };
    const waiter = {
      pid: 2,
      ppid: 1,
      pgid: 2,
      args: `bash scripts/heavy-slot.sh --wait other ${cmd}`,
    };
    expect(countHeavyJobs([shell, waiter], 0)).toBe(0);
    // the same shell with no wrapper below it still names a job of its own
    expect(countHeavyJobs([shell], 0)).toBe(1);
  });
  // R930: the shape measured 2026-11-11 with an invented command: the harness's shell, the job's
  // shell and `timeout` (which moves itself into a new group) are three groups for one job.
  test("R930: shells above a job's own process add no job; a reader is never one", () => {
    const cmd = "bun packages/runner/src/cli.ts run --project /x";
    const procs = [
      { pid: 1, ppid: 0, pgid: 1, args: `/bin/bash -c source snap.sh && eval 'timeout 9 ${cmd}'` },
      { pid: 2, ppid: 1, pgid: 2, args: `bash scripts/heavy-slot.sh other timeout 9 ${cmd}` },
      { pid: 3, ppid: 2, pgid: 3, args: `timeout 9 ${cmd}` },
      { pid: 4, ppid: 3, pgid: 3, args: cmd },
    ];
    expect(countHeavyJobs(procs, 0)).toBe(1);
    const grep = { pid: 5, ppid: 0, pgid: 5, args: `grep -E cli.ts run|itest` };
    expect(countHeavyJobs([grep, ...procs], 0)).toBe(1);
  });
  test("R930: a shell with no job below it still counts (only it may name the work)", () => {
    // review r2 (corpus-snapshot): only the shell names the corpus; its child names nothing heavy.
    const census = [
      { pid: 6, ppid: 0, pgid: 6, args: "bash -c cd /work/src/BC.History && bun census.ts ." },
      { pid: 7, ppid: 6, pgid: 6, args: "bun census.ts ." },
    ];
    expect(countHeavyJobs(census, 0)).toBe(1);
    // A retry loop between attempts reads as a job too: the safe direction (a skipped update).
    const loop = {
      pid: 8,
      ppid: 0,
      pgid: 8,
      args: "sh -c until bun packages/runner/src/cli.ts run --project /x; do sleep 60; done",
    };
    expect(countHeavyJobs([loop], 0)).toBe(1);
  });
  test("R930: two real jobs started through shells still count as two", () => {
    const job = (g: number, cmd: string) => [
      { pid: g, ppid: 0, pgid: g, args: `bash -c timeout 9 ${cmd}` },
      { pid: g + 1, ppid: g, pgid: g + 1, args: `timeout 9 ${cmd}` },
      { pid: g + 2, ppid: g + 1, pgid: g + 1, args: cmd },
    ];
    const procs = [
      ...job(10, "bun packages/runner/src/cli.ts run --project /a"),
      ...job(20, "/home/dev/.bun/bin/bun packages/runner/itest/al-runner-v3.itest.ts"),
    ];
    expect(countHeavyJobs(procs, 0)).toBe(2);
    expect(countHeavyJobs(procs, 1, ["baseapp"])).toBe(3);
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
  test("R905: two jobs with a BaseApp-class or unclassed slot fill the container; two other do not", () => {
    expect(countHeavyJobs([], 2, ["baseapp", "other"])).toBe(3);
    expect(countHeavyJobs([], 2, [undefined, "other"])).toBe(3);
    expect(countHeavyJobs([], 2, ["other", "other"])).toBe(2);
    expect(countHeavyJobs([], 1, ["baseapp"])).toBe(1);
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

  test("R861: a rejudge publishes pending rows at once, and a rejudge with none publishes nothing", async () => {
    await setupKept();
    await writeFile(
      join(root, "gated-builds.jsonl"),
      `${JSON.stringify({ id: "edge-pending" })}\n`,
    );
    const pending = rj({ outcome: "pass" });
    expect(await edgeRejudge(pending.deps, EDGE)).toBe("pass");
    expect(pending.seen.published).toEqual(["edge-pending"]);
    await setupKept();
    await rm(join(root, "gated-builds.jsonl"), { force: true });
    await rm(join(root, "gated-builds.published"), { force: true });
    const none = rj();
    expect(await edgeRejudge(none.deps, EDGE)).toBe("gate-fail");
    expect(none.seen.published).toEqual([]);
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

  test("R1016: a rejudge with a sidecar builder runs its repros on a staged copy WITH the sidecar; no kept file changes and no sidecar lands there", async () => {
    await setupKept();
    const before = await tree();
    const f = rj();
    const repros: string[] = [];
    const beside: boolean[] = [];
    const deps = {
      ...f.deps,
      buildSidecar: async (_c: string, out: string) => {
        await writeFile(join(out, "AlDotNetSidecar.dll"), "dll");
        return join(out, "AlDotNetSidecar.dll");
      },
      upstreamRepros: async (candidate: string) => {
        repros.push(candidate);
        // Read at call time: the work folder is gone once gateOne returns.
        beside.push(existsSync(join(dirname(candidate), "dotnet-sidecar", "AlDotNetSidecar.dll")));
        return [];
      },
    };
    expect(await edgeRejudge(deps, EDGE)).toBe("gate-fail");
    // The gate keeps the kept binary (R6); the repros run a copy outside failed/ and held/, with its sidecar.
    expect(f.seen.envs[0]?.LETHAL_ALRUNNER_V3_PATH).toBe(join(kept(), "al-runner"));
    expect(repros.length).toBe(1);
    const r = repros[0] ?? "";
    expect(r.startsWith(join(root, "failed")) || r.startsWith(join(root, "held"))).toBe(false);
    expect(beside).toEqual([true]);
    const after = await tree();
    // A gate-fail at this commit adds its own failed/<name>@<commit>/ (by design); no sidecar lands in any kept folder.
    expect(Object.keys(after).filter((p) => p.includes("dotnet-sidecar"))).toEqual([]);
    for (const [p, bytes] of Object.entries(before)) expect(after[p]).toBe(bytes);
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

  test("PR-117: a qualifying receipt writes batchFacts into the ledger row too; a non-qualifying one writes none", async () => {
    const ALL = Object.fromEntries(V3_CAPABILITY_FACTS.map((n) => [n, "matches"]));
    await setupPinned();
    const yes = fake({
      ...pinnedPass,
      batchFacts: ALL,
      dbmBatched: true,
      legs: { ...legsFor("pass"), DBM: "pass" },
    });
    expect(await updateOnce(yes.deps)).toEqual(["pass"]);
    const [r] = await ledger();
    expect(r.batchFacts).toEqual(ALL);
    await rm(join(root, "gated-builds.jsonl"), { force: true });
    await setupPinned();
    const no = fake({
      ...pinnedPass,
      batchFacts: ALL,
      dbmBatched: true,
      legs: { ...legsFor("pass"), DBM: "gate-fail" },
    });
    expect(await updateOnce(no.deps)).toEqual(["pass"]);
    const [r2] = await ledger();
    expect("batchFacts" in r2).toBe(false);
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

  test("R886: a pass builds the sidecar beside the binary and records its file and sha in .gated and the row", async () => {
    await setupPinned();
    const f = edgeOf(pinnedPass);
    const asked: string[] = [];
    // R1016: the repros run a binary with its sidecar beside it, built once, before the gate; the gate runs the original
    // binary with none (its frozen figures were measured without one).
    const beside = (p: string) =>
      existsSync(join(dirname(p), "dotnet-sidecar", "AlDotNetSidecar.dll"));
    const atGate: boolean[] = [];
    const repros: boolean[] = [];
    const deps = {
      ...f.deps,
      buildSidecar: async (commit: string, out: string) => {
        asked.push(commit);
        await writeFile(join(out, "AlDotNetSidecar.dll"), "dll");
        return join(out, "AlDotNetSidecar.dll");
      },
      runGate: async (
        c: string,
        env: Readonly<Record<string, string>>,
        log: (l: string) => Promise<void>,
      ) => {
        atGate.push(beside(env.LETHAL_ALRUNNER_V3_PATH ?? ""));
        return f.deps.runGate(c, env, log);
      },
      upstreamRepros: async (candidate: string) => {
        repros.push(beside(candidate));
        return [];
      },
    };
    expect(await edgeOnce(deps)).toBe("pass");
    expect(asked).toEqual(["c893e3633"]);
    expect(atGate).toEqual([false]);
    expect(repros).toEqual([true]);
    const want = { file: "dotnet-sidecar/AlDotNetSidecar.dll", sha256: sha("dll") };
    expect((await gatedOf(EDGE_DIR)).dotnetSidecar).toEqual(want);
    const [r] = await ledger();
    expect(r.dotnetSidecarSha256).toBe(want.sha256);
    expect(existsSync(join(root, EDGE_DIR, want.file))).toBe(true);
  });

  test("R886: a sidecar that fails to build still gates: current moves, the note is in .gated and the row", async () => {
    await setupPinned();
    const f = edgeOf(pinnedPass);
    let tries = 0;
    const repros: boolean[] = [];
    const deps = {
      ...f.deps,
      buildSidecar: async (_c: string, out: string) => {
        tries++;
        // A half-built folder must not stay where al-runner would find it.
        await writeFile(join(out, "partial.dll"), "half");
        throw new Error("dotnet publish: exit 1");
      },
      upstreamRepros: async (candidate: string) => {
        repros.push(existsSync(join(dirname(candidate), "dotnet-sidecar")));
        return [];
      },
    };
    expect(await edgeOnce(deps)).toBe("pass");
    expect(await current()).toBe(join(root, EDGE_DIR));
    const g = await gatedOf(EDGE_DIR);
    expect(g.dotnetSidecar).toBeUndefined();
    expect(g.dotnetSidecarNote).toContain("dotnet publish: exit 1");
    const [r] = await ledger();
    expect(r.dotnetSidecarNote).toContain("dotnet publish: exit 1");
    expect(r.dotnetSidecarSha256).toBeUndefined();
    expect(f.seen.logs.join("\n")).toContain("the build still gates");
    // R1016: the build was tried once, the gate still ran, and the repros saw no sidecar folder (the half-built one is gone).
    expect(tries).toBe(1);
    expect(f.seen.gates.length).toBe(1);
    expect(repros).toEqual([false]);
    expect(existsSync(join(root, EDGE_DIR, "dotnet-sidecar"))).toBe(false);
  });

  test("R886: no buildSidecar dep, no sidecar fields at all", async () => {
    await setupPinned();
    expect(await edgeOnce(edgeOf(pinnedPass).deps)).toBe("pass");
    const g = await gatedOf(EDGE_DIR);
    expect(g.dotnetSidecar).toBeUndefined();
    expect(g.dotnetSidecarNote).toBeUndefined();
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

  test("PR-59: the fixed scan runs once per daily run and its lines are logged", async () => {
    await setupPinned();
    const f = fake({ ...pinnedPass, tags: TAGS });
    let calls = 0;
    const deps = {
      ...f.deps,
      edgeCommit: async () => "c893e3633",
      fixedScan: async () => {
        calls++;
        return ["#1 t | fixed-in-current"];
      },
    };
    expect(await dailyOnce(deps)).toEqual({ edge: "pass", releases: ["pass"] });
    expect(calls).toBe(1);
    expect(f.seen.logs.join("\n")).toContain("upstream-fixed-scan: #1 t | fixed-in-current");
  });

  test("PR-59: the fixed scan runs outside the gate lock, and on a day the gate skips for memory", async () => {
    await setupPinned();
    const f = fake({ ...pinnedPass, tags: TAGS, mem: { refuse: true, message: "no memory" } });
    let calls = 0;
    let lockHeld: boolean | undefined;
    const deps = {
      ...f.deps,
      edgeCommit: async () => "c893e3633",
      fixedScan: async () => {
        calls++;
        lockHeld = existsSync(join(root, ".gate.lock"));
        return [];
      },
    };
    expect(await dailyOnce(deps)).toEqual({ edge: "skipped", releases: [] });
    expect(calls).toBe(1);
    expect(lockHeld).toBe(false);
    expect(f.seen.published).toEqual([]);
  });

  test("PR-59: a throwing fixed scan changes no outcome and is logged", async () => {
    await setupPinned();
    const f = fake({ ...pinnedPass, tags: TAGS });
    const deps = {
      ...f.deps,
      edgeCommit: async () => "c893e3633",
      fixedScan: async () => {
        throw new Error("gh is down");
      },
    };
    expect(await dailyOnce(deps)).toEqual({ edge: "pass", releases: ["pass"] });
    expect(f.seen.published).toEqual(["edge-c893e3633", "alpha.3-c893e3633"]);
    expect(f.seen.logs.join("\n")).toContain("upstream-fixed-scan: not run: Error: gh is down");
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

// R859: `--refresh-rows`, with fakes. A row is replaced only on its own gate's pass.
linuxOnly("R859: refreshRows", () => {
  const PIN = "edge-d72d3197d";
  const row = (c: string, over: Record<string, unknown> = {}) => ({
    id: `edge-${c}`,
    track: "edge",
    version: `al-runner 3.0.0-alpha.13+edge.20261106 (${c})`,
    binarySha256: sha(`bin-${c}`),
    readingsFrom: PIN,
    readingsDigest: "0".repeat(64),
    lethalCommit: GATED_COMMIT,
    gatedAt: "2026-11-06T07:56:28.135Z",
    ...over,
  });
  /** A root with `current`, two kept binaries and a manifest of two rows (A and B). */
  async function world(over: Record<string, unknown> = {}, keep = ["aaaaaaaaa", "bbbbbbbbb"]) {
    await setup();
    for (const c of keep) {
      await mkdir(join(root, `edge-${c}-${c}`), { recursive: true });
      await writeFile(join(root, `edge-${c}-${c}`, "al-runner"), `bin-${c}`);
    }
    const manifestPath = join(root, "manifest.json");
    await writeFile(
      manifestPath,
      `${JSON.stringify([row("aaaaaaaaa", over), row("bbbbbbbbb")], null, 2)}\n`,
    );
    return manifestPath;
  }
  const mk = (manifestPath: string, o: Parameters<typeof fake>[0] = {}, dirty = false) => {
    const f = fake({ outcome: "pass", realSha: true, pinApplied: PIN, ...o });
    return { ...f, deps: { ...f.deps, manifestPath, isDirty: async () => dirty } };
  };
  const untouched = async (path: string, before: string) => {
    expect(await readFile(path, "utf8")).toBe(before);
    for (const d of ["failed", "held", "gated-builds.published", "gated-builds.jsonl"])
      expect(existsSync(join(root, d))).toBe(false);
    expect(await current()).toBe(join(root, ALPHA2_DIR));
  };

  test("PR-117 (M-1): a refresh drops the old row's batchFacts when its receipt does not qualify, and writes this gate's when it does", async () => {
    const OLD = Object.fromEntries(V3_CAPABILITY_FACTS.map((n) => [n, "matches"]));
    const NEW = { ...OLD, "batch-lane-hint-only": "unmeasurable" };
    const p = await world({ batchFacts: OLD });
    const { deps } = mk(p, {
      ancestor: () => false,
      legs: { ...legsFor("pass"), DBM: "gate-fail" },
    });
    expect(await refreshRows(deps, ["edge-aaaaaaaaa"])).toEqual(["pass"]);
    const [a] = JSON.parse(await readFile(p, "utf8"));
    expect("batchFacts" in a).toBe(false);
    const p2 = await world({ batchFacts: OLD });
    const q = mk(p2, {
      ancestor: () => false,
      batchFacts: NEW,
      dbmBatched: true,
      legs: { ...legsFor("pass"), DBM: "pass" },
    });
    expect(await refreshRows(q.deps, ["edge-aaaaaaaaa"])).toEqual(["pass"]);
    const [a2] = JSON.parse(await readFile(p2, "utf8"));
    expect(a2.batchFacts).toEqual(NEW);
  });

  test("R-996 (review): a refresh runs no upstream repros", async () => {
    const p = await world({ warnFacts: { "serve-keep-reasons": "differs" } });
    const { deps } = mk(p, {
      ancestor: () => false,
      warnFacts: { "serve-keep-reasons": "matches" },
    });
    const calls: string[][] = [];
    const withRepros = {
      ...deps,
      upstreamRepros: async (candidate: string, cur: string) => {
        calls.push([candidate, cur]);
        return [];
      },
    };
    expect(await refreshRows(withRepros, ["edge-aaaaaaaaa"])).toEqual(["pass"]);
    expect(calls).toEqual([]);
  });

  test("a pass replaces that row's digest and commit, and nothing else; the receipt names it", async () => {
    const p = await world({ warnFacts: { "serve-keep-reasons": "differs" } });
    const before = await readFile(p, "utf8");
    const { deps, seen } = mk(p, {
      ancestor: () => false,
      warnFacts: { "serve-keep-reasons": "matches" },
    });
    expect(await refreshRows(deps, ["edge-aaaaaaaaa"])).toEqual(["pass"]);
    const [a, b] = JSON.parse(await readFile(p, "utf8"));
    // The digest, commit, gatedAt and warnFacts come from THIS gate; nothing else moves.
    expect(a).toEqual(
      row("aaaaaaaaa", {
        readingsDigest: digestOfPin(PIN),
        lethalCommit: FIXED_COMMIT,
        gatedAt: "2026-10-21T00:00:00Z",
        warnFacts: { "serve-keep-reasons": "matches" },
      }),
    );
    expect(b).toEqual(row("bbbbbbbbb"));
    // The second row's text is byte-identical.
    const tail = (t: string) => t.slice(t.indexOf('"id": "edge-bbbbbbbbb"'));
    expect(tail(await readFile(p, "utf8"))).toBe(tail(before));
    expect(seen.gates).toEqual([FIXED_COMMIT]);
    expect(seen.envs[0]?.LETHAL_V3_PIN_FROM).toBe(PIN);
    expect(seen.envs[0]?.LETHAL_ALRUNNER_V3_PATH).toBe(
      join(root, "edge-aaaaaaaaa-aaaaaaaaa", "al-runner"),
    );
    for (const d of ["failed", "held", "gated-builds.published", "gated-builds.jsonl"])
      expect(existsSync(join(root, d))).toBe(false);
    expect(await current()).toBe(join(root, ALPHA2_DIR));
    const rc = JSON.parse(
      await readFile(
        join(root, "refresh", `refresh-edge-aaaaaaaaa@${FIXED_COMMIT}`, "refresh.json"),
        "utf8",
      ),
    );
    expect(rc).toMatchObject({
      binary: join(root, "edge-aaaaaaaaa-aaaaaaaaa", "al-runner"),
      binarySha256: sha("bin-aaaaaaaaa"),
      oldDigest: "0".repeat(64),
      newDigest: digestOfPin(PIN),
      lethalCommit: FIXED_COMMIT,
      outcome: "pass",
    });
    expect(existsSync(join(root, ".gate.lock"))).toBe(false);
  });

  for (const outcome of ["gate-fail", "held", "infra-fail"] as const) {
    test(`a ${outcome} writes nothing`, async () => {
      const p = await world();
      const before = await readFile(p, "utf8");
      const { deps } = mk(p, { outcome });
      expect(await refreshRows(deps, ["edge-aaaaaaaaa", "edge-bbbbbbbbb"])).toEqual([outcome]);
      await untouched(p, before);
    });
  }

  test("a pass that applied another pin is an infra-fail and writes nothing", async () => {
    const p = await world();
    const before = await readFile(p, "utf8");
    const { deps } = mk(p, { pinApplied: "alpha.12-d4bc8d3a5" });
    expect(await refreshRows(deps, ["edge-aaaaaaaaa"])).toEqual(["infra-fail"]);
    await untouched(p, before);
  });

  test("a skipped run (heavy load, or the lock held by a live update) writes nothing and gates nothing", async () => {
    const p = await world();
    const before = await readFile(p, "utf8");
    const busy = mk(p, { heavy: 3 });
    expect(await refreshRows(busy.deps, ["edge-aaaaaaaaa"])).toEqual(["skipped"]);
    await writeFile(
      join(root, ".gate.lock"),
      JSON.stringify({ pid: 4242, startedAt: "2026-10-20T00:00:00Z", argv: [] }),
    );
    const held = mk(p, { procs: { 4242: "bun scripts/al-runner-v3-update.ts --edge" } });
    expect(await refreshRows(held.deps, ["edge-aaaaaaaaa"])).toEqual(["skipped"]);
    expect(busy.seen.gates.length + held.seen.gates.length).toBe(0);
    expect(await readFile(p, "utf8")).toBe(before);
  });

  test("refusals, each by name, before any gate: wrong sha, unknown id, missing binary, no hand pin, dirty, no ids", async () => {
    const cases: [string, () => Promise<[string, boolean, string[]]>, RegExp][] = [
      [
        "sha",
        async () => {
          const p = await world();
          await writeFile(join(root, "edge-aaaaaaaaa-aaaaaaaaa", "al-runner"), "changed");
          return [p, false, ["edge-aaaaaaaaa"]];
        },
        /does not have the row's sha256/,
      ],
      ["unknown", async () => [await world(), false, ["edge-ccccccccc"]], /is not a row/],
      [
        "missing",
        async () => [await world({}, ["bbbbbbbbb"]), false, ["edge-aaaaaaaaa"]],
        /no kept binary/,
      ],
      [
        "pin",
        async () => [await world({ readingsFrom: "nope" }), false, ["edge-aaaaaaaaa"]],
        /no hand pin/,
      ],
      ["dirty", async () => [await world(), true, ["edge-aaaaaaaaa"]], /uncommitted/],
      ["none", async () => [await world(), false, []], /name each row/],
      // The second id is bad: the first must not be gated either.
      [
        "second",
        async () => [await world(), false, ["edge-aaaaaaaaa", "edge-ccccccccc"]],
        /is not a row/,
      ],
    ];
    for (const [, setupCase, why] of cases) {
      const [p, dirty, ids] = await setupCase();
      const before = await readFile(p, "utf8");
      const { deps, seen } = mk(p, {}, dirty);
      await expect(refreshRows(deps, ids)).rejects.toThrow(why);
      expect(seen.gates).toEqual([]);
      await untouched(p, before);
    }
  });

  test("a short head, a duplicate id and a manifest not in the script's format are refused before any gate", async () => {
    const p = await world();
    const before = await readFile(p, "utf8");
    const short = mk(p, { self: "abc1234" });
    await expect(refreshRows(short.deps, ["edge-aaaaaaaaa"])).rejects.toThrow(/full sha/);
    const dup = mk(p);
    await expect(refreshRows(dup.deps, ["edge-aaaaaaaaa", "edge-aaaaaaaaa"])).rejects.toThrow(
      /name each row once/,
    );
    await writeFile(p, JSON.stringify(JSON.parse(before)));
    const compact = await readFile(p, "utf8");
    const fmt = mk(p);
    await expect(refreshRows(fmt.deps, ["edge-aaaaaaaaa"])).rejects.toThrow(/own format/);
    expect(short.seen.gates.length + dup.seen.gates.length + fmt.seen.gates.length).toBe(0);
    expect(await readFile(p, "utf8")).toBe(compact);
  });

  test("a pass then a fail across two ids keeps the first row and leaves the second", async () => {
    const p = await world();
    const { deps, seen } = mk(p, { seq: ["pass", "gate-fail"] });
    expect(await refreshRows(deps, ["edge-aaaaaaaaa", "edge-bbbbbbbbb"])).toEqual([
      "pass",
      "gate-fail",
    ]);
    expect(seen.gates.length).toBe(2);
    const written = [
      row("aaaaaaaaa", {
        readingsDigest: digestOfPin(PIN),
        lethalCommit: FIXED_COMMIT,
        gatedAt: "2026-10-21T00:00:00Z",
      }),
      row("bbbbbbbbb"),
    ];
    // The whole file, byte for byte: only the first row differs from the start.
    expect(await readFile(p, "utf8")).toBe(`${JSON.stringify(written, null, 2)}\n`);
    expect(existsSync(join(root, "failed"))).toBe(false);
  });

  test("a head that moved during the gate, or a row that vanished, refuses by name and writes nothing", async () => {
    for (const how of ["head", "row"] as const) {
      const p = await world();
      let moved = false;
      const { deps, seen } = mk(p, {
        onGate: async () => {
          moved = true;
          if (how === "row") await writeFile(p, `${JSON.stringify([row("bbbbbbbbb")], null, 2)}\n`);
        },
      });
      deps.selfCommit = async () => (how === "head" && moved ? GATED_COMMIT : FIXED_COMMIT);
      const rowsBefore = how === "row" ? `${JSON.stringify([row("bbbbbbbbb")], null, 2)}\n` : "";
      const before = await readFile(p, "utf8");
      const err = await refreshRows(deps, ["edge-aaaaaaaaa"]).then(
        () => "",
        (e: Error) => e.message,
      );
      expect(err).toMatch(how === "head" ? /head moved during the gate/ : /no longer a row/);
      expect(await readFile(p, "utf8")).toBe(how === "row" ? rowsBefore : before);
      expect(seen.logs.join("\n")).toMatch(/REFUSED, nothing written/);
      const rc = JSON.parse(
        await readFile(
          join(root, "refresh", `refresh-edge-aaaaaaaaa@${FIXED_COMMIT}`, "refresh.json"),
          "utf8",
        ),
      );
      expect(rc.outcome).toMatch(/^refused: /);
    }
  });

  test("the receipt is written before the manifest: a receipt that cannot be written leaves the manifest alone", async () => {
    const p = await world();
    const before = await readFile(p, "utf8");
    // A read-only receipt folder: the gate's own copy is only logged, the receipt write fails.
    const dir = join(root, "refresh", `refresh-edge-aaaaaaaaa@${FIXED_COMMIT}`);
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o555);
    const { deps } = mk(p);
    try {
      await expect(refreshRows(deps, ["edge-aaaaaaaaa"])).rejects.toThrow();
      expect(await readFile(p, "utf8")).toBe(before);
    } finally {
      await chmod(dir, 0o755);
    }
  });

  test("a stale pass receipt for the same id and head is removed when the run then fails", async () => {
    const p = await world();
    const dir = join(root, "refresh", `refresh-edge-aaaaaaaaa@${FIXED_COMMIT}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "refresh.json"), '{"outcome":"pass"}');
    const { deps } = mk(p, { outcome: "gate-fail" });
    expect(await refreshRows(deps, ["edge-aaaaaaaaa"])).toEqual(["gate-fail"]);
    expect(existsSync(join(dir, "refresh.json"))).toBe(false);
  });
});

// PR-226: gate a local build privately (`--root`, `--local-candidate`).
describe("PR-226: parseUpdateArgs and dispatchUpdate (the one strict dispatcher)", () => {
  const FULL = "a".repeat(40);
  const refused = (argv: string[]) => {
    try {
      parseUpdateArgs(argv);
    } catch (err) {
      return String(err);
    }
    return undefined;
  };

  test("each existing mode parses as before; no argument is the daily mode", () => {
    expect(parseUpdateArgs([])).toEqual({ mode: "daily" });
    expect(parseUpdateArgs(["--pin-digests"])).toEqual({ mode: "pin-digests" });
    expect(parseUpdateArgs(["--edge"])).toEqual({ mode: "edge" });
    expect(parseUpdateArgs(["--refresh-rows", "a,b,,c"])).toEqual({
      mode: "refresh-rows",
      ids: ["a", "b", "c"],
    });
    expect(parseUpdateArgs(["--edge-rejudge", "c893e3633"])).toEqual({
      mode: "edge-rejudge",
      sha: "c893e3633",
    });
    expect(parseUpdateArgs(["--regate", FULL])).toEqual({ mode: "regate", commit: FULL });
    expect(parseUpdateArgs(["--root", "/x/r", "--local-candidate", "/x/c"])).toEqual({
      mode: "private",
      root: "/x/r",
      candidate: "/x/c",
    });
    // The two private flags may come in either order.
    expect(parseUpdateArgs(["--local-candidate", "/x/c", "--root", "/x/r"])).toEqual({
      mode: "private",
      root: "/x/r",
      candidate: "/x/c",
    });
  });

  test("R4/R5: an unknown argument, an `=` spelling, a missing value, a value that starts with `-`, a duplicate: each refused by name", () => {
    const bad: string[][] = [
      ["--bogus"],
      ["stray"],
      ["--root=x"],
      ["--local-candidate=y"],
      ["--root=x", "--local-candidate", "y"],
      ["--root"],
      ["--root", "--local-candidate", "y"],
      ["--root", "x", "--local-candidate"],
      ["--root", "x", "--local-candidate", "-y"],
      ["--root", "a", "--root", "b", "--local-candidate", "c"],
      ["--regate"],
      ["--regate", "abc"],
      ["--regate", `${FULL}0`],
      ["--edge-rejudge"],
      ["--edge-rejudge", "--edge"],
      ["--refresh-rows"],
      ["--edge", "--edge"],
    ];
    for (const argv of bad) {
      const text = refused(argv);
      expect(text, argv.join(" ")).toMatch(/al-runner-v3-update-args-refused/);
    }
  });

  test("R1/R2: `--root` alone and `--local-candidate` alone are refused by name", () => {
    expect(refused(["--root", "/x/r"])).toMatch(/--root and --local-candidate come together/);
    expect(refused(["--local-candidate", "/x/c"])).toMatch(
      /--root and --local-candidate come together/,
    );
  });

  test("R4: either private flag with any mode flag is refused, in any order", () => {
    const modes: string[][] = [
      ["--regate", FULL],
      ["--edge"],
      ["--edge-rejudge", "c893e3633"],
      ["--refresh-rows", "a"],
      ["--pin-digests"],
    ];
    for (const m of modes) {
      for (const argv of [
        [...m, "--root", "r", "--local-candidate", "c"],
        ["--root", "r", "--local-candidate", "c", ...m],
        ["--root", "r", ...m],
        ["--local-candidate", "c", ...m],
      ])
        expect(refused(argv), argv.join(" ")).toMatch(/al-runner-v3-update-args-refused/);
    }
  });

  test("two mode flags are refused (one dispatcher, one mode)", () => {
    expect(refused(["--edge", "--pin-digests"])).toMatch(/one mode/);
  });

  function counters() {
    const ran: string[] = [];
    const h: UpdateHandlers = {
      pinDigests: async () => void ran.push("pin-digests"),
      refreshRows: async (ids) => void ran.push(`refresh-rows:${ids.join(",")}`),
      edge: async () => void ran.push("edge"),
      edgeRejudge: async (sha) => void ran.push(`edge-rejudge:${sha}`),
      regate: async (c) => void ran.push(`regate:${c}`),
      daily: async () => void ran.push("daily"),
      privateGate: async (r, c) => void ran.push(`private:${r}:${c}`),
    };
    return { ran, h };
  }

  test("the CLI refusals run NO mode function (no daily, edge, regate, rejudge, refresh, private)", async () => {
    for (const argv of [
      ["--root=x"],
      ["--root", "x", "--local-candidate", "y", "--edge"],
      ["--root", "--local-candidate", "y"],
      ["--root", "x"],
      ["--local-candidate", "y"],
      ["--root", "x", "--local-candidate", "y", "--regate", FULL],
      ["--bogus"],
      ["--edge", "--bogus"],
    ]) {
      const { ran, h } = counters();
      await expect(dispatchUpdate(argv, h), argv.join(" ")).rejects.toThrow(
        /al-runner-v3-update-args-refused/,
      );
      expect(ran, argv.join(" ")).toEqual([]);
    }
  });

  test("each good argv runs exactly its own mode function", async () => {
    const cases: [string[], string][] = [
      [[], "daily"],
      [["--edge"], "edge"],
      [["--pin-digests"], "pin-digests"],
      [["--refresh-rows", "a,b"], "refresh-rows:a,b"],
      [["--edge-rejudge", "c893e3633"], "edge-rejudge:c893e3633"],
      [["--regate", FULL], `regate:${FULL}`],
      [["--root", "/r", "--local-candidate", "/c"], "private:/r:/c"],
    ];
    for (const [argv, want] of cases) {
      const { ran, h } = counters();
      await dispatchUpdate(argv, h);
      expect(ran, argv.join(" ")).toEqual([want]);
    }
  });
});

linuxOnly("PR-226: the defaults are unchanged (D1-D3)", () => {
  test("D1: realDeps() has root ROOT and gateWorktree GATE_WORKTREE; an option changes only the worktree", () => {
    const d = realDeps();
    expect(d.root).toBe(ROOT);
    expect(d.gateWorktree).toBe(GATE_WORKTREE);
    const p = realDeps("/some/root", { gateWorktree: "/some/root/gate-worktree" });
    expect(p.root).toBe("/some/root");
    expect(p.gateWorktree).toBe("/some/root/gate-worktree");
  });

  test("D2: no flags gives the daily mode, and the daily path still calls publishPending (a ledger row goes to publishEntries)", async () => {
    expect(parseUpdateArgs([])).toEqual({ mode: "daily" });
    await setup();
    const f = join(await current(), ".gated");
    await writeFile(
      f,
      JSON.stringify({
        ...JSON.parse(await readFile(f, "utf8")),
        readingsFrom: "alpha.12-d4bc8d3a5",
      }),
    );
    await writeFile(join(root, "gated-builds.jsonl"), `${JSON.stringify({ id: "edge-old" })}\n`);
    const { deps, seen } = edgeOf({
      outcome: "pass",
      pinApplied: "alpha.12-d4bc8d3a5",
      tags: ["edge"],
    });
    await dailyOnce(deps);
    expect(seen.published).toContain("edge-old");
  });

  test("D3: a default candidate still comes from download, SHA256SUMS is checked, and the gate is not private", async () => {
    await setup();
    const bad = fake({ outcome: "pass", badSums: true });
    expect(await updateOnce(bad.deps)).toEqual(["infra-fail"]);
    expect(bad.seen.downloads).toBe(1);
    expect(bad.seen.extracts).toBe(0);
    expect(bad.seen.gates).toEqual([]);
    const good = fake({ outcome: "pass" });
    expect(await updateOnce(good.deps)).toEqual(["pass"]);
    expect(good.seen.downloads).toBe(1);
    expect(good.seen.envs[0]?.LETHAL_ALRUNNER_V3_CACHE).toBeUndefined();
    expect(existsSync(join(root, "private"))).toBe(false);
    expect(existsSync(join(root, "builds"))).toBe(false);
    expect(existsSync(join(root, ALPHA3_DIR, "al-runner"))).toBe(true);
  });
});

describe("PR-226: checkPrivateRoot (R3)", () => {
  let scratch = "";
  afterEach(async () => {
    if (scratch !== "") await rm(scratch, { recursive: true, force: true });
    scratch = "";
  });

  test("R3: the tools folder and anything under it is refused; a sibling named toolsx is accepted (portable paths)", async () => {
    scratch = await mkdtemp(join(tmpdir(), "lethal-pr226-r3-"));
    const tools = join(scratch, "tools");
    await mkdir(tools);
    await mkdir(join(scratch, "toolsx"));
    for (const bad of [
      tools,
      join(tools, "al-runner-v3"),
      join(tools, "not", "yet", "there"),
      join(scratch, "toolsx", "..", "tools", "x"),
    ])
      await expect(checkPrivateRoot(bad, tools), bad).rejects.toThrow(/under/);
    for (const ok of [
      join(scratch, "toolsx"),
      join(scratch, "toolsx", "priv"),
      join(scratch, "elsewhere"),
    ])
      await expect(checkPrivateRoot(ok, tools), ok).resolves.toBeUndefined();
  });

  test("B1: isUnderRoot compares by path.relative, so a Windows path (a drive, backslashes) is judged right", () => {
    const w = path.win32;
    const t = "D:\\work\\tools";
    expect(isUnderRoot(t, t, w)).toBe(true);
    expect(isUnderRoot("D:\\work\\tools\\al-runner-v3", t, w)).toBe(true);
    expect(isUnderRoot("D:\\work\\toolsx", t, w)).toBe(false);
    expect(isUnderRoot("D:\\work\\toolsx\\priv", t, w)).toBe(false);
    expect(isUnderRoot("E:\\work\\tools\\x", t, w)).toBe(false);
    expect(isUnderRoot("D:\\work", t, w)).toBe(false);
    expect(isUnderRoot("/work/tools/x", "/work/tools", path.posix)).toBe(true);
    expect(isUnderRoot("/work/toolsx", "/work/tools", path.posix)).toBe(false);
  });

  linuxOnly("R3 (Linux paths)", () => {
    test("the literal /work/tools is refused; /work/toolsx is accepted", async () => {
      await expect(checkPrivateRoot("/work/tools")).rejects.toThrow(/under \/work\/tools/);
      await expect(checkPrivateRoot("/work/tools/not/yet/there")).rejects.toThrow(
        /under \/work\/tools/,
      );
      await expect(checkPrivateRoot("/work/toolsx/priv")).resolves.toBeUndefined();
    });

    test("R3: a symlink into the tools folder is refused", async () => {
      scratch = await mkdtemp(join(tmpdir(), "lethal-pr226-r3l-"));
      const tools = join(scratch, "tools");
      await mkdir(tools);
      await symlink(tools, join(scratch, "link"));
      await expect(checkPrivateRoot(join(scratch, "link", "new", "deeper"), tools)).rejects.toThrow(
        /under/,
      );
      await expect(checkPrivateRoot(join(scratch, "link"), tools)).rejects.toThrow(/under/);
    });
  });
});

describe("PR-226: copyCacheTree reads the source and never writes it", () => {
  test("a copy equal to the source, the source byte-identical after", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lethal-pr226-cache-"));
    try {
      const src = join(dir, "src");
      await mkdir(join(src, "compile"), { recursive: true });
      await writeFile(join(src, "compile", "a.bin"), "AAA");
      await writeFile(join(src, "b.txt"), "B");
      const list = async (d: string) => (await readdir(d, { recursive: true })).sort();
      const before = await list(src);
      await copyCacheTree(src, join(dir, "dst"));
      expect(await list(join(dir, "dst"))).toEqual(before);
      expect(await readFile(join(dir, "dst", "compile", "a.bin"), "utf8")).toBe("AAA");
      expect(await list(src)).toEqual(before);
      expect(await readFile(join(src, "compile", "a.bin"), "utf8")).toBe("AAA");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

linuxOnly("PR-226: privateGateOnce", () => {
  const ROOT_PIN = "alpha.12-d4bc8d3a5";
  const TAG = `local-${sha("alpha3").slice(0, 12)}`;
  let scratch = "";
  let priv = "";
  const made: string[] = [];
  afterEach(async () => {
    for (const d of made.splice(0)) await rm(d, { recursive: true, force: true });
    scratch = "";
    priv = "";
  });

  /** Every file and link under `dir`, with content hashes: the byte-level picture of a tree. */
  async function snap(dir: string): Promise<string> {
    const out: string[] = [];
    const walk = async (d: string): Promise<void> => {
      for (const e of (await readdir(d, { withFileTypes: true })).sort((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        const p = join(d, e.name);
        if (e.isSymbolicLink()) out.push(`${p} -> ${await readlink(p)}`);
        else if (e.isDirectory()) {
          out.push(`${p}/`);
          await walk(p);
        } else out.push(`${p} ${sha(await readFile(p, "utf8"))}`);
      }
    };
    await walk(dir);
    return out.join("\n");
  }

  /** A shared root (`root`, with `current`), a private root, a candidate and the counting fakes. */
  async function world(
    o: Parameters<typeof fake>[0] = {},
    opt: { pinned?: boolean; candidateAs?: "file" | "folder" } = {},
  ) {
    await setup();
    if (opt.pinned === true) {
      const f = join(await current(), ".gated");
      await writeFile(
        f,
        JSON.stringify({ ...JSON.parse(await readFile(f, "utf8")), readingsFrom: ROOT_PIN }),
      );
    }
    scratch = await mkdtemp(join(tmpdir(), "lethal-pr226-"));
    made.push(scratch);
    priv = join(scratch, "priv");
    const candDir = join(scratch, "cand");
    await mkdir(candDir);
    await writeFile(join(candDir, "al-runner"), "alpha3");
    await chmod(join(candDir, "al-runner"), 0o755);
    const sharedCache = join(scratch, "shared-cache");
    await mkdir(sharedCache);
    const f = fake({ outcome: "pass", realSha: true, ...o });
    const calls = { list: 0, download: 0, order: 0, copy: [] as string[][], cwd: [] as string[] };
    const deps: UpdateDeps = {
      ...f.deps,
      root: priv,
      gateWorktree: join(priv, "gate-worktree"),
      listReleases: async () => {
        calls.list += 1;
        return [];
      },
      download: async () => {
        calls.download += 1;
        throw new Error("a private gate never downloads");
      },
      commitOrder: async () => {
        calls.order += 1;
        return "ahead";
      },
      procsWithCwdUnder: async (d) => {
        calls.cwd.push(d);
        return o.orphans ?? [];
      },
    };
    const run = (over: Partial<Parameters<typeof privateGateOnce>[1]> = {}) =>
      privateGateOnce(deps, {
        sharedRoot: root,
        candidate: opt.candidateAs === "folder" ? candDir : join(candDir, "al-runner"),
        env: {},
        sharedCache,
        copyCache: async (from, to) => {
          calls.copy.push([from, to]);
          await mkdir(to, { recursive: true });
        },
        ...over,
      });
    return { ...f, deps, calls, run, candDir, sharedCache };
  }

  const receiptDirs = async () =>
    existsSync(join(priv, "private"))
      ? (await readdir(join(priv, "private"))).filter((n) => n !== "update.log")
      : [];
  const allNames = async () => (await readdir(priv, { recursive: true })).map((n) => String(n));

  async function untouched(w: Awaited<ReturnType<typeof world>>, sharedBefore: string) {
    expect(await snap(root)).toBe(sharedBefore);
    expect(w.calls.download).toBe(0);
    expect(w.calls.list).toBe(0);
    expect(w.calls.order).toBe(0);
    expect(w.seen.downloads).toBe(0);
    expect(w.seen.published).toEqual([]);
    for (const n of ["gated-builds.jsonl", "gated-builds.published", "current", "failed", "held"])
      expect(existsSync(join(priv, n)), n).toBe(false);
    // The only `.gated` a private run may write is the gated copy's, and only on a pass.
    expect(
      (await allNames()).filter((n) => n.endsWith(".gated") && !n.startsWith("builds/")),
    ).toEqual([]);
  }

  test("P1: a pass: outcome pass; the shared root is byte-identical; no ledger, current, failed or held; nothing fetched; the receipt is under <root>/private/ (a `current` with NO readingsFrom)", async () => {
    const w = await world();
    const before = await snap(root);
    const r = await w.run();
    expect(r.outcome).toBe("pass");
    await untouched(w, before);
    const dirs = await receiptDirs();
    expect(dirs.length).toBe(1);
    expect(dirs[0]).toMatch(new RegExp(`^${TAG}@${GATED_COMMIT}-[0-9a-f-]{36}$`));
    expect(r.dir).toBe(join(priv, "private", dirs[0] ?? ""));
    expect(existsSync(join(r.dir ?? "", "receipt.json"))).toBe(true);
    expect(w.seen.gates).toEqual([GATED_COMMIT]);
  });

  for (const [name, outcome] of [
    ["P2", "gate-fail"],
    ["P3", "held"],
    ["P4", "infra-fail"],
  ] as const) {
    test(`${name}: a ${outcome}: the outcome is returned, the receipt is kept under <root>/private/, and nothing else is written (G2: no .gated, no build folder, anywhere)`, async () => {
      const w = await world({ outcome });
      const before = await snap(root);
      const r = await w.run();
      expect(r.outcome).toBe(outcome);
      await untouched(w, before);
      expect(existsSync(join(priv, "builds"))).toBe(false);
      expect((await allNames()).filter((n) => n.includes(".gated"))).toEqual([]);
      const dirs = await receiptDirs();
      expect(dirs.length).toBe(1);
      expect(existsSync(join(priv, "private", dirs[0] ?? "", "receipt.json"))).toBe(true);
      // The fake gate was given the cache under <root>.
      expect(w.seen.envs[0]?.LETHAL_ALRUNNER_V3_CACHE).toBe(join(priv, "cache"));
    });
  }

  test("P5: the gate runs at current's lethalCommit, by pinRootOf(current), with the candidate variables and the cache under <root>; the receipt is read as a candidate (K must pass)", async () => {
    const w = await world({ pinApplied: ROOT_PIN }, { pinned: true });
    expect((await w.run()).outcome).toBe("pass");
    expect(w.seen.gates).toEqual([GATED_COMMIT]);
    const env = w.seen.envs[0] ?? {};
    expect(env.LETHAL_V3_PIN_FROM).toBe(ROOT_PIN);
    expect(env.LETHAL_ALRUNNER_V3_CANDIDATE).toBe("1");
    expect(env.LETHAL_ITEST_V3_K_ON_CANDIDATE).toBe("1");
    expect(env.LETHAL_ITEST_ALRUNNER_V3).toBe("1");
    expect(env.LETHAL_ITEST_V3_TABLES).toBe("1");
    expect(env.LETHAL_ALRUNNER_V3_CACHE).toBe(join(priv, "cache"));
    expect(env.LETHAL_ALRUNNER_V3_CACHE?.startsWith(`${priv}/`)).toBe(true);
    expect(env.LETHAL_V3_GATE_RECEIPT?.startsWith(`${priv}/`)).toBe(true);
    // As a candidate: a pass whose K did not pass is not a pass.
    const k = await world(
      { pinApplied: ROOT_PIN, legs: { ...legsFor("pass"), K: "gate-fail" } },
      { pinned: true },
    );
    expect((await k.run()).outcome).toBe("gate-fail");
  });

  test("P6: a pass whose receipt applied another pin than pinRootOf(current) is infra-fail, and writes no .gated (a `current` with NO readingsFrom)", async () => {
    const w = await world({ pinApplied: ROOT_PIN });
    const r = await w.run();
    expect(r.outcome).toBe("infra-fail");
    expect(existsSync(join(priv, "builds"))).toBe(false);
    expect((await allNames()).filter((n) => n.includes(".gated"))).toEqual([]);
    expect(w.seen.logs.join("\n")).toMatch(
      /a pass that applied pin alpha\.12-d4bc8d3a5, not \(none\)/,
    );
  });

  test("P6b: a `current` with NO readingsFrom whose version and sha256 ARE a hand pin: the pin comes from findV3Pin, and a pass that applied it passes (the old `gated.readingsFrom` check would call it infra-fail)", async () => {
    // A real hand pin of al-runner-v3-pins.ts: pinRootOf(current) is its id only through findV3Pin.
    const HAND = {
      id: "alpha.5-07342060e",
      version: "al-runner 3.0.0-alpha.5 (07342060e)",
      binarySha256: "fd4d6d406a2f2170fccfe13413d51bbb1317b78b3ef5af3800ca9a6009b51db2",
    };
    const w = await world({ pinApplied: HAND.id });
    const f = join(await current(), ".gated");
    // No readingsFrom: the pin must come from findV3Pin(version, sha256) alone.
    const { readingsFrom: _none, ...g } = JSON.parse(await readFile(f, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(
      f,
      JSON.stringify({ ...g, version: HAND.version, binarySha256: HAND.binarySha256 }),
    );
    const r = await w.run();
    expect(r.outcome).toBe("pass");
    const gated = parseGated(await readFile(join(priv, "builds", TAG, ".gated"), "utf8"), "x");
    expect(gated.readingsFrom).toBe(HAND.id);
    expect(w.seen.envs[0]?.LETHAL_V3_PIN_FROM).toBe(HAND.id);
  });

  test("G1: a pass writes <root>/builds/<tag>/al-runner (mode 755, the candidate's bytes) and the gate's own .gated beside it, and nothing outside <root>", async () => {
    const w = await world({ pinApplied: ROOT_PIN }, { pinned: true });
    const sharedBefore = await snap(root);
    const candBefore = await snap(w.candDir);
    expect((await w.run()).outcome).toBe("pass");
    const dest = join(priv, "builds", TAG);
    expect(await readFile(join(dest, "al-runner"), "utf8")).toBe("alpha3");
    expect((await stat(join(dest, "al-runner"))).mode & 0o777).toBe(0o755);
    const g = parseGated(await readFile(join(dest, ".gated"), "utf8"), "x");
    expect(g.binarySha256).toBe(sha("alpha3"));
    expect(g.version).toBe("al-runner 3.0.0-alpha.3 (c893e3633)");
    expect(g.lethalCommit).toBe(GATED_COMMIT);
    expect(g.readingsFrom).toBe(ROOT_PIN);
    expect(g.gatedAt).toBe("2026-10-21T00:00:00Z");
    expect(await snap(root)).toBe(sharedBefore);
    expect(await snap(w.candDir)).toBe(candBefore);
    expect((await readdir(scratch)).sort()).toEqual(["cand", "priv", "shared-cache"]);
    expect(existsSync(join(priv, "current"))).toBe(false);
    expect(existsSync(join(priv, "gated-builds.jsonl"))).toBe(false);
  });

  test("G3: checkGated accepts the private copy on that .gated; it refuses the same binary with no .gated, and a .gated whose sha256 differs", async () => {
    const w = await world();
    expect((await w.run()).outcome).toBe("pass");
    const dest = join(priv, "builds", TAG);
    const version = "al-runner 3.0.0-alpha.3 (c893e3633)";
    const none = { findBuild: () => undefined };
    const ok = await checkGated(join(dest, "al-runner"), version, none);
    expect(ok.binarySha256).toBe(sha("alpha3"));
    // The same bytes with no `.gated` beside them.
    const bare = join(scratch, "bare");
    await mkdir(bare);
    await writeFile(join(bare, "al-runner"), "alpha3");
    await expect(checkGated(join(bare, "al-runner"), version, none)).rejects.toThrow(
      /not a gated build/,
    );
    // A `.gated` that names another sha256.
    const g = JSON.parse(await readFile(join(dest, ".gated"), "utf8"));
    await writeFile(join(dest, ".gated"), JSON.stringify({ ...g, binarySha256: sha("other") }));
    await expect(checkGated(join(dest, "al-runner"), version, none)).rejects.toThrow(/pins/);
  });

  test("a changed copy (its sha256 not the receipt's) is infra-fail and leaves no .gated", async () => {
    const w = await world();
    // The candidate changes between the gate and the copy: the gate's own hook edits it.
    const f = w.deps.runGate;
    const deps2 = {
      ...w.deps,
      runGate: async (...a: Parameters<typeof f>) => {
        await f(...a);
        await writeFile(join(w.candDir, "al-runner"), "alpha3-changed");
      },
    };
    const r = await privateGateOnce(deps2, {
      sharedRoot: root,
      candidate: join(w.candDir, "al-runner"),
      env: {},
      sharedCache: w.sharedCache,
      copyCache: async (_f, to) => mkdir(to, { recursive: true }).then(() => undefined),
    });
    expect(r.outcome).toBe("infra-fail");
    expect((await allNames()).filter((n) => n.includes(".gated"))).toEqual([]);
  });

  test("one receipt folder per run: a second run's receipt never overwrites the first's (builds/ is covered by the S2 tests)", async () => {
    const w = await world();
    const a = await w.run();
    expect(a.outcome).toBe("pass");
    const second = fake({ outcome: "gate-fail", realSha: true });
    const b = await privateGateOnce(
      { ...w.deps, runGate: second.deps.runGate },
      {
        sharedRoot: root,
        candidate: join(w.candDir, "al-runner"),
        env: {},
        sharedCache: w.sharedCache,
        copyCache: async () => undefined,
      },
    );
    expect(b.outcome).toBe("gate-fail");
    expect(a.dir).not.toBe(b.dir);
    expect((await receiptDirs()).length).toBe(2);
    expect(JSON.parse(await readFile(join(a.dir ?? "", "receipt.json"), "utf8")).outcome).toBe(
      "pass",
    );
    expect(JSON.parse(await readFile(join(b.dir ?? "", "receipt.json"), "utf8")).outcome).toBe(
      "gate-fail",
    );
  });

  type World = Awaited<ReturnType<typeof world>>;
  /** Another gate run on the same private root and candidate, by another fake gate. */
  const again = (w: World, o: Parameters<typeof fake>[0], over: Partial<UpdateDeps> = {}) => {
    const s = fake({ realSha: true, ...o });
    return privateGateOnce(
      { ...w.deps, runGate: s.deps.runGate, ...over },
      {
        sharedRoot: root,
        candidate: join(w.candDir, "al-runner"),
        env: {},
        sharedCache: w.sharedCache,
        copyCache: async () => undefined,
      },
    );
  };
  const VERSION3 = "al-runner 3.0.0-alpha.3 (c893e3633)";
  const NO_MANIFEST = { findBuild: () => undefined };
  const buildNames = async () => readdir(join(priv, "builds", TAG));

  test("S2a: a pass, then a gate-fail of the same bytes: the old .gated is retired, so checkGated accepts nothing; the retirement is logged", async () => {
    const w = await world();
    expect((await w.run()).outcome).toBe("pass");
    const copy = join(priv, "builds", TAG, "al-runner");
    expect((await checkGated(copy, VERSION3, NO_MANIFEST)).binarySha256).toBe(sha("alpha3"));
    expect((await again(w, { outcome: "gate-fail" })).outcome).toBe("gate-fail");
    await expect(checkGated(copy, VERSION3, NO_MANIFEST)).rejects.toThrow(/not a gated build/);
    expect((await buildNames()).filter((n) => n.startsWith(".gated.retired-")).length).toBe(1);
    expect(w.seen.logs.join("\n")).toMatch(/retired/);
  });

  test("S2a: a held and an infra-fail after a pass retire the .gated too", async () => {
    for (const o of ["held", "infra-fail"] as const) {
      const w = await world();
      expect((await w.run()).outcome).toBe("pass");
      expect((await again(w, { outcome: o })).outcome).toBe(o);
      expect(existsSync(join(priv, "builds", TAG, ".gated")), o).toBe(false);
    }
  });

  test("S2b/c: a copy whose sha256 differs removes only its own tmp copy: the earlier pass stays valid", async () => {
    const w = await world();
    expect((await w.run()).outcome).toBe("pass");
    const s = fake({ outcome: "pass", realSha: true });
    const r = await again(
      w,
      {},
      {
        runGate: async (...a) => {
          await s.deps.runGate(...a);
          // The bytes change AFTER the gate measured them and BEFORE the copy.
          await writeFile(join(w.candDir, "al-runner"), "alpha3-changed");
        },
      },
    );
    expect(r.outcome).toBe("infra-fail");
    const copy = join(priv, "builds", TAG, "al-runner");
    expect(await readFile(copy, "utf8")).toBe("alpha3");
    expect((await checkGated(copy, VERSION3, NO_MANIFEST)).binarySha256).toBe(sha("alpha3"));
    expect((await buildNames()).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });

  test("S2b: a pass leaves no tmp file beside the copy and .gated", async () => {
    const w = await world();
    expect((await w.run()).outcome).toBe("pass");
    expect((await buildNames()).sort()).toEqual([".gated", "al-runner"]);
  });

  test("S2d: a copy or rename error (here: the target is a non-empty folder) is infra-fail with the error text, and writes no .gated", async () => {
    const w = await world();
    await mkdir(join(priv, "builds", TAG, "al-runner", "sub"), { recursive: true });
    const r = await w.run();
    expect(r.outcome).toBe("infra-fail");
    expect(existsSync(join(priv, "builds", TAG, ".gated"))).toBe(false);
    expect(w.seen.logs.join("\n")).toMatch(
      /infra-fail: the gated copy could not be written: .*(EISDIR|ENOTDIR|ENOTEMPTY|EEXIST)/,
    );
    expect((await buildNames()).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });

  test("the cache: seeded once from the shared cache, atomically (copied beside it, then renamed), never the source, not seeded again", async () => {
    const w = await world();
    await w.run();
    expect(w.calls.copy.length).toBe(1);
    expect(w.calls.copy[0]?.[0]).toBe(w.sharedCache);
    expect(w.calls.copy[0]?.[1]?.startsWith(join(priv, "cache.tmp-"))).toBe(true);
    expect(existsSync(join(priv, "cache"))).toBe(true);
    expect((await readdir(priv)).filter((n) => n.startsWith("cache.tmp-"))).toEqual([]);
    await w.run();
    expect(w.calls.copy.length).toBe(1);
  });

  test("S1: a seed that writes a file and then throws leaves no <root>/cache and no tmp folder; the next run seeds again", async () => {
    const w = await world();
    await expect(
      w.run({
        copyCache: async (_f, to) => {
          await mkdir(to, { recursive: true });
          await writeFile(join(to, "half.bin"), "x");
          throw new Error("disk full");
        },
      }),
    ).rejects.toThrow(/disk full/);
    expect(existsSync(join(priv, "cache"))).toBe(false);
    expect((await readdir(priv)).filter((n) => n.startsWith("cache.tmp-"))).toEqual([]);
    expect(existsSync(join(priv, ".gate.lock"))).toBe(false);
    expect(w.seen.gates).toEqual([]);
    expect((await w.run()).outcome).toBe("pass");
    expect(w.calls.copy.length).toBe(1);
    expect(existsSync(join(priv, "cache"))).toBe(true);
  });

  test("S3: a pre-made <root>/cache (or builds, private, gate-worktree) that is a symlink is refused by name, and nothing is written through it", async () => {
    for (const name of ["cache", "builds", "private", "gate-worktree"]) {
      const w = await world();
      const tools = join(scratch, "tools");
      const target = join(tools, "target");
      await mkdir(target, { recursive: true });
      await mkdir(priv, { recursive: true });
      await symlink(target, join(priv, name));
      await expect(w.run({ toolsRoot: tools }), name).rejects.toThrow(
        new RegExp(`al-runner-v3-private-refused.*${name}`),
      );
      expect(await readdir(target), name).toEqual([]);
      expect(w.seen.gates).toEqual([]);
    }
  });

  test("a root that is the shared install is refused by name", async () => {
    const w = await world();
    await expect(
      privateGateOnce(
        { ...w.deps, root },
        {
          sharedRoot: root,
          candidate: join(w.candDir, "al-runner"),
          env: {},
          sharedCache: w.sharedCache,
          copyCache: async () => undefined,
        },
      ),
    ).rejects.toThrow(/al-runner-v3-private-refused.*shared install/);
    expect(w.seen.gates).toEqual([]);
  });

  test("a private gate never builds a sidecar and never runs upstream repros (even when the deps offer them)", async () => {
    const w = await world();
    let sidecar = 0;
    let repros = 0;
    const r = await again(
      w,
      { outcome: "pass" },
      {
        buildSidecar: async () => {
          sidecar += 1;
          throw new Error("no");
        },
        upstreamRepros: async () => {
          repros += 1;
          return [];
        },
      },
    );
    expect(r.outcome).toBe("pass");
    expect([sidecar, repros]).toEqual([0, 0]);
  });

  test("onPrivateDir: the folder is reported only when a receipt was kept (no receipt: no folder, no dir)", async () => {
    const w = await world();
    const r = await again(w, {}); // a gate that writes no receipt
    expect(r.outcome).toBe("infra-fail");
    expect(r.dir).toBeUndefined();
    expect(await receiptDirs()).toEqual([]);
  });

  test("the refusals about a stale `current` come before the memory check, the lock and the cache seed", async () => {
    const w = await world({ legsByCommit: { [GATED_COMMIT]: ["C"] }, ancestor: () => false });
    let memory = 0;
    await expect(
      privateGateOnce(
        {
          ...w.deps,
          gateMemory: async () => {
            memory += 1;
            return undefined;
          },
        },
        {
          sharedRoot: root,
          candidate: join(w.candDir, "al-runner"),
          env: {},
          sharedCache: w.sharedCache,
          copyCache: async (f, t) => void w.calls.copy.push([f, t]),
        },
      ),
    ).rejects.toThrow(/al-runner-v3-private-refused/);
    expect(memory).toBe(0);
    expect(w.calls.copy).toEqual([]);
    expect(existsSync(join(priv, "cache"))).toBe(false);
  });

  test("the env refusals: any LETHAL_ITEST_V3_* but _CDO, any LETHAL_ALRUNNER_V3_*, and LETHAL_V3_PIN_FROM are refused by name before anything is made or run", async () => {
    for (const name of [
      "LETHAL_ITEST_V3_TABLES",
      "LETHAL_ITEST_V3_K_ON_CANDIDATE",
      "LETHAL_ALRUNNER_V3_PATH",
      "LETHAL_ALRUNNER_V3_CACHE",
      "LETHAL_V3_PIN_FROM",
    ]) {
      const w = await world();
      await expect(w.run({ env: { [name]: "x" } }), name).rejects.toThrow(
        new RegExp(`al-runner-v3-private-refused.*${name}`),
      );
      expect(w.seen.gates).toEqual([]);
      expect(existsSync(priv), name).toBe(false);
    }
    const ok = await world();
    expect(
      (await ok.run({ env: { LETHAL_ITEST_V3_CDO: "/some/cdo", PATH: "/usr/bin" } })).outcome,
    ).toBe("pass");
  });

  test("a root under /work/tools is refused before anything is made or run", async () => {
    const w = await world();
    await expect(
      privateGateOnce(
        { ...w.deps, root: "/work/tools/al-runner-v3-pr226-test", gateWorktree: "/x" },
        {
          sharedRoot: root,
          candidate: join(w.candDir, "al-runner"),
          env: {},
          sharedCache: w.sharedCache,
          copyCache: async () => undefined,
        },
      ),
    ).rejects.toThrow(/under \/work\/tools/);
    expect(w.seen.gates).toEqual([]);
    expect(existsSync("/work/tools/al-runner-v3-pr226-test")).toBe(false);
  });

  test("--local-candidate: a file or a folder holding an executable al-runner is accepted; anything else is refused by name", async () => {
    const folder = await world({}, { candidateAs: "folder" });
    expect((await folder.run()).outcome).toBe("pass");
    const w = await world();
    const bad: string[] = [
      join(scratch, "missing"),
      join(scratch, "cand", "nope"),
      scratch, // a folder with no al-runner
    ];
    await writeFile(join(scratch, "plain"), "alpha3");
    await chmod(join(scratch, "plain"), 0o644);
    bad.push(join(scratch, "plain"));
    for (const c of bad)
      await expect(w.run({ candidate: c }), c).rejects.toThrow(/al-runner-v3-private-refused/);
    expect(w.seen.gates).toEqual([]);
  });

  test("the lock is <root>/.gate.lock, held during the gate and released after; a busy machine skips like the daily gate", async () => {
    let held = false;
    const w = await world({
      onGate: async () => {
        held = existsSync(join(priv, ".gate.lock"));
      },
    });
    expect((await w.run()).outcome).toBe("pass");
    expect(held).toBe(true);
    expect(existsSync(join(priv, ".gate.lock"))).toBe(false);
    const busy = await world({ mem: { refuse: true, message: "no memory" } });
    expect((await busy.run()).outcome).toBe("skipped");
    expect(busy.seen.gates).toEqual([]);
    expect(busy.seen.logs.join("\n")).toMatch(/skipped for the day: no memory/);
  });

  test("W1: the lock's orphan check and its skip message name <root>/gate-worktree, never GATE_WORKTREE", async () => {
    const w = await world({ orphans: [777] });
    await mkdir(priv, { recursive: true });
    await writeFile(
      join(priv, ".gate.lock"),
      JSON.stringify({ pid: 4242, startedAt: "2026-10-20T00:00:00Z", argv: [] }),
    );
    expect((await w.run()).outcome).toBe("skipped");
    expect(w.calls.cwd).toEqual([join(priv, "gate-worktree")]);
    const text = w.seen.logs.join("\n");
    expect(text).toContain(`still run under ${join(priv, "gate-worktree")}`);
    expect(text).toContain(`check that no process runs under ${join(priv, "gate-worktree")}`);
    expect(text).not.toContain(GATE_WORKTREE);
    expect(w.seen.gates).toEqual([]);
  });

  test("W1: the default deps still name GATE_WORKTREE in the lock's orphan check", async () => {
    await setup();
    const cwd: string[] = [];
    const f = fake({ outcome: "pass" });
    await writeFile(
      join(root, ".gate.lock"),
      JSON.stringify({ pid: 4242, startedAt: "2026-10-20T00:00:00Z", argv: [] }),
    );
    const deps = {
      ...f.deps,
      procsWithCwdUnder: async (d: string) => {
        cwd.push(d);
        return [1];
      },
    };
    expect(await updateOnce(deps)).toEqual(["skipped"]);
    expect(cwd).toEqual([GATE_WORKTREE]);
    expect(f.seen.logs.join("\n")).toContain(`still run under ${GATE_WORKTREE}`);
  });

  test("W1: the real runGate checks out in <root>/gate-worktree, never GATE_WORKTREE", async () => {
    scratch = await mkdtemp(join(tmpdir(), "lethal-pr226-w1-"));
    made.push(scratch);
    const gw = join(scratch, "gate-worktree");
    // No real command ever runs: the runner is a fake that records the argv and then stops the gate.
    const argvs: string[][] = [];
    const stop = new Error("stopped by the fake runner");
    const fakeRun = async (argv: string[]) => {
      argvs.push(argv);
      throw stop;
    };
    const d = realDeps(scratch, { gateWorktree: gw, run: fakeRun });
    // No worktree yet: the first command is `git worktree add <gw>`.
    await expect(d.runGate("c0ffee", {}, async () => {})).rejects.toBe(stop);
    // A worktree there: the first command is `git -C <gw> checkout`.
    await mkdir(gw);
    await expect(d.runGate("c0ffee", {}, async () => {})).rejects.toBe(stop);
    expect(argvs.length).toBe(2);
    expect(argvs[0]).toContain(gw);
    expect(argvs[1]).toEqual(["git", "-C", gw, "checkout", "--detach", "c0ffee"]);
    expect(argvs.flat()).not.toContain(GATE_WORKTREE);
  });

  test("privateRealDeps: root, worktree under it, and the log is <root>/private/update.log", async () => {
    scratch = await mkdtemp(join(tmpdir(), "lethal-pr226-log-"));
    made.push(scratch);
    const d = privateRealDeps(scratch);
    expect(d.root).toBe(scratch);
    expect(d.gateWorktree).toBe(join(scratch, "gate-worktree"));
    await d.log("a line");
    await d.log("another");
    expect(await readFile(join(scratch, "private", "update.log"), "utf8")).toBe(
      "a line\nanother\n",
    );
  });

  test("a stale .gated (legs missing): the candidate is judged at the script's own commit, and the re-gate of current is never called", async () => {
    const w = await world({ legsByCommit: { [GATED_COMMIT]: ["C"] } });
    const sharedBefore = await snap(root);
    // Caught, so a re-gate of current (which needs <root>/current) fails by assertion, not by a crash.
    const r = await w.run().catch((e: unknown) => ({ outcome: `threw ${String(e)}` }));
    expect(w.seen.logs.join("\n")).not.toMatch(/re-gating current/);
    expect(w.seen.envs.filter((e) => e.LETHAL_ALRUNNER_V3_CANDIDATE !== "1")).toEqual([]);
    expect(r.outcome).toBe("pass");
    // One gate only: the candidate's, at self. A re-gate of current would be a second run, at self,
    // and would write <root>/regate.
    expect(w.seen.gates).toEqual([FIXED_COMMIT]);
    expect(w.seen.envs[0]?.LETHAL_ALRUNNER_V3_CANDIDATE).toBe("1");
    expect(existsSync(join(priv, "regate"))).toBe(false);
    expect(await snap(root)).toBe(sharedBefore);
    const g = parseGated(await readFile(join(priv, "builds", TAG, ".gated"), "utf8"), "x");
    expect(g.lethalCommit).toBe(FIXED_COMMIT);
  });

  test("a stale .gated and a script commit that cannot serve: refused by name, nothing gated, nothing re-gated", async () => {
    const w = await world({
      legsByCommit: { [GATED_COMMIT]: ["C"] },
      ancestor: () => false, // not on origin/master
    });
    await expect(w.run()).rejects.toThrow(/al-runner-v3-private-refused.*origin\/master/);
    expect(w.seen.gates).toEqual([]);
    expect(existsSync(join(priv, "regate"))).toBe(false);
    // The lock was released on the refusal.
    expect(existsSync(join(priv, ".gate.lock"))).toBe(false);
  });
});
