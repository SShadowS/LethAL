// R586 T19 (plan r2 §12, r3 F6, r4 I-3): the v3 update gate with fakes, every outcome both ways.
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { V3_GATE_LEGS } from "../packages/runner/itest/al-runner-v3-gate";
import {
  FIXTURE_SYMBOLS_TAR_SHA256,
  HEAVY_JOB,
  type Outcome,
  type UpdateDeps,
  V3_CDO_DEFAULT,
  candidates,
  edgeOnce,
  expectedSha,
  gatePreparation,
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
  heavy?: number;
  free?: number;
  /** Written as `gate.log` beside the receipt, as `realDeps().runGate` does (R633 I1). */
  gateLog?: string;
  /** The gate throws this after writing its files (a non-zero exit). */
  throwText?: string;
}) {
  const seen = {
    gates: [] as string[],
    envs: [] as Readonly<Record<string, string>>[],
    extracts: 0,
    logs: [] as string[],
  };
  const deps: UpdateDeps = {
    heavyJobs: async () => o.heavy ?? 0,
    freeGb: async () => o.free ?? 20,
    root,
    listReleases: async () =>
      o.tags ?? ["edge", "v3.0.0-alpha.3", "v3.0.0-alpha.2", "v3.0.0-alpha.1"],
    download: async (_tag, dir) => {
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
    versionOf: async () => "al-runner 3.0.0-alpha.3 (c893e3633)",
    runGate: async (commit, env) => {
      seen.gates.push(commit);
      seen.envs.push(env);
      const receiptPath = env.LETHAL_V3_GATE_RECEIPT ?? "";
      if (o.gateLog !== undefined)
        await writeFile(join(dirname(receiptPath), "gate.log"), o.gateLog);
      if (o.outcome === undefined) {
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
          outcome: o.outcome,
          legs: o.legs ?? legsFor(o.outcome),
          lines: o.lines ?? [],
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
  test("candidates: alphas above the gated one, oldest first, never edge", () => {
    expect(
      candidates(["edge", "v3.0.0-alpha.4", "v3.0.0-alpha.3", "v3.0.0-alpha.2", "v2.12.0"], 2),
    ).toEqual(["v3.0.0-alpha.3", "v3.0.0-alpha.4"]);
    expect(expectedSha(`${"a".repeat(64)}  x.tar.xz\n`, "/d/x.tar.xz")).toBe("a".repeat(64));
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

  test("R632 D: the alpha path and --regate are skipped with 2 heavy jobs or under 10 GB; 1 and 10 proceed", async () => {
    await setup();
    for (const o of [{ heavy: 2 }, { free: 9 }]) {
      const a = fake({ outcome: "pass", ...o });
      expect(await updateOnce(a.deps)).toEqual(["skipped"]);
      const r = fake({ outcome: "pass", receiptSha: sha("alpha2"), ...o });
      expect(await updateOnce(r.deps, { regateAt: REGATE_COMMIT })).toEqual(["skipped"]);
      expect(a.seen.gates.length + r.seen.gates.length).toBe(0);
      expect(a.seen.logs.join("\n")).toMatch(/skipped for the day/);
    }
    expect(await updateOnce(fake({ outcome: "pass", heavy: 1, free: 10 }).deps)).toEqual(["pass"]);
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

describe("M4: the gate worktree is prepared, or refused by name", () => {
  test("bun install (F5: --frozen-lockfile) and the native parser build always run", () => {
    const p = gatePreparation({ worktree: "/w", alpackagesPresent: true, symbolTar: undefined });
    expect("steps" in p && p.steps).toEqual([
      ["bun", "install", "--frozen-lockfile"],
      ["bun", "scripts/build-native-parser.ts"],
    ]);
  });
  test("missing fixture .alpackages are extracted from the PINNED symbol tar", () => {
    const p = gatePreparation({
      worktree: "/w",
      alpackagesPresent: false,
      symbolTar: "/t.tar",
      symbolTarSha256: FIXTURE_SYMBOLS_TAR_SHA256,
    });
    expect("steps" in p && p.steps.at(-1)).toEqual(["tar", "-xf", "/t.tar", "-C", "/w"]);
  });
  test("F5: a symbol tar with another sha256 (or none computed) is refused by name", () => {
    for (const symbolTarSha256 of ["0".repeat(64), undefined]) {
      const p = gatePreparation({
        worktree: "/w",
        alpackagesPresent: false,
        symbolTar: "/t.tar",
        ...(symbolTarSha256 !== undefined ? { symbolTarSha256 } : {}),
      });
      expect("refused" in p && p.refused).toMatch(/al-runner-v3-gate-symbol-tar-mismatch/);
    }
  });
  test("missing .alpackages and no tar: refused by name", () => {
    const p = gatePreparation({ worktree: "/w", alpackagesPresent: false, symbolTar: undefined });
    expect("refused" in p && p.refused).toMatch(/al-runner-v3-gate-worktree-unprepared/);
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

  test("skipped with 2 heavy jobs or under 10 GB; 1 heavy job and 10 GB proceed", async () => {
    await setup();
    const a = edge({ outcome: "pass" }, { heavy: 2 });
    expect(await edgeOnce(a.deps)).toBe("skipped");
    expect(a.seen.logs.join("\n")).toMatch(/2 heavy jobs/);
    const b = edge({ outcome: "pass" }, { free: 9 });
    expect(await edgeOnce(b.deps)).toBe("skipped");
    expect(b.seen.logs.join("\n")).toMatch(/9 GB/);
    expect(a.seen.gates.length + b.seen.gates.length).toBe(0);
    const c = edge({ outcome: "pass" }, { heavy: 1, free: 10 });
    expect(await edgeOnce(c.deps)).toBe("pass");
  });
});
