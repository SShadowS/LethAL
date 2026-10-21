// R586 T19 (plan r2 §12, r3 F6, r4 I-3): the v3 update gate with fakes, every outcome both ways.
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Outcome,
  type UpdateDeps,
  candidates,
  expectedSha,
  updateOnce,
} from "./al-runner-v3-update";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const GATED_COMMIT = "abcdef1234567";

let root = "";
afterEach(async () => {
  if (root !== "") await rm(root, { recursive: true, force: true });
});

async function setup(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), "lethal-r586-update-"));
  const cur = join(root, "3.0.0-alpha.2-91253f2d6");
  await mkdir(cur, { recursive: true });
  await writeFile(join(cur, "al-runner"), "alpha2");
  await writeFile(
    join(cur, ".gated"),
    JSON.stringify({
      version: "alrunner 3.0.0-alpha.2 (91253f2d6)",
      binarySha256: sha("alpha2"),
      lethalCommit: GATED_COMMIT,
    }),
  );
  await symlink(cur, join(root, "current"));
  return root;
}

function fake(o: {
  outcome?: Outcome;
  badNonce?: boolean;
  badSha?: boolean;
  badSums?: boolean;
  inUse?: boolean;
  tags?: string[];
}) {
  const seen = { gates: [] as string[], extracts: 0, logs: [] as string[] };
  const deps: UpdateDeps = {
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
      if (o.outcome === undefined) return;
      await writeFile(
        env.LETHAL_V3_GATE_RECEIPT ?? "",
        JSON.stringify({
          nonce: o.badNonce === true ? "stale" : env.LETHAL_V3_GATE_NONCE,
          binarySha256: o.badSha === true ? sha("other") : sha("alpha3"),
          outcome: o.outcome,
          legs: {},
        }),
      );
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

describe("T19: the v3 update gate", () => {
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
    expect(existsSync(join(root, "failed", "v3.0.0-alpha.3"))).toBe(false);
  });

  test("a checksum mismatch is infra-fail and the tarball is never extracted", async () => {
    await setup();
    const { deps, seen } = fake({ outcome: "pass", badSums: true });
    expect(await updateOnce(deps)).toEqual(["infra-fail"]);
    expect(seen.extracts).toBe(0);
    expect(seen.gates).toEqual([]);
  });

  test("gate-fail goes to failed/ for good: the next run does not gate it again", async () => {
    await setup();
    const a = fake({ outcome: "gate-fail" });
    expect(await updateOnce(a.deps)).toEqual(["gate-fail"]);
    expect(existsSync(join(root, "failed", "v3.0.0-alpha.3", "al-runner"))).toBe(true);
    const b = fake({ outcome: "pass" });
    expect(await updateOnce(b.deps)).toEqual(["gate-fail"]);
    expect(b.seen.gates).toEqual([]);
  });

  test("held is kept under held/, never blacklisted, and current does not move", async () => {
    await setup();
    const { deps, seen } = fake({ outcome: "held" });
    expect(await updateOnce(deps)).toEqual(["held"]);
    expect(existsSync(join(root, "held", "v3.0.0-alpha.3"))).toBe(true);
    expect(existsSync(join(root, "failed", "v3.0.0-alpha.3"))).toBe(false);
    expect(await current()).toBe(join(root, "3.0.0-alpha.2-91253f2d6"));
    expect(seen.logs.some((l) => l.includes("HELD"))).toBe(true);
  });

  test("--regate gates the CURRENT build at the new commit; on pass .gated takes that commit", async () => {
    await setup();
    const { deps, seen } = fake({ outcome: "pass" });
    deps.versionOf = async () => "alrunner 3.0.0-alpha.2 (91253f2d6)";
    const { runGate } = deps;
    deps.runGate = async (c, env) => {
      await writeFile(
        env.LETHAL_V3_GATE_RECEIPT ?? "",
        JSON.stringify({
          nonce: env.LETHAL_V3_GATE_NONCE,
          binarySha256: sha("alpha2"),
          outcome: "pass",
          legs: {},
        }),
      );
      seen.gates.push(c);
      void runGate;
    };
    expect(await updateOnce(deps, { regateAt: "1234567abcdef" })).toEqual(["pass"]);
    expect(seen.gates).toEqual(["1234567abcdef"]);
    const g = JSON.parse(await readFile(join(await current(), ".gated"), "utf8"));
    expect(g.lethalCommit).toBe("1234567abcdef");
  });
});
