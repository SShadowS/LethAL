// R586 §8 and §12: the v3 contract probe against a fake v3 (and a fake alc), and the `.gated`
// pin (T18). Every refusal has a test per direction.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type V3ContractResult,
  runV3ContractProbe,
  v3ContractRefusals,
  v3DefectsGone,
} from "../src/al-runner-v3-contract";
import { V3_PREDEFINED_CANDIDATES } from "../src/al-runner-v3-probe";
import { AlRunnerV3UngatedBuildError, checkGated, parseGated, sha256OfFile } from "../src/al-runner-v3-pin";
import type { ArtifactIo } from "../src/artifact";
import type { SpawnFn } from "../src/publisher";

const VERSION = "alrunner 3.0.0-alpha.2 (91253f2d6)";
const BC = "28.0.46665.47126";

type Over = Partial<Record<string, (argv: readonly string[]) => { exitCode: number; stdout: string; stderr?: string } | undefined>>;

const row = (cu: number, method: string, status: string, o: { message?: string; notRun?: boolean; durationMs?: number } = {}) => ({
  codeunit: cu,
  method,
  name: `Codeunit${cu}.${method}`,
  status,
  durationMs: o.durationMs ?? 0,
  ...(o.message !== undefined ? { message: o.message } : {}),
  ...(o.notRun === true ? { notRun: true } : {}),
});
const doc = (tests: unknown[]) => JSON.stringify({ tests });

/** A fake alpha.2 that answers every probe call as measured; `over` replaces one answer by key. */
function fakeV3(over: Over = {}): SpawnFn {
  return async (argv, _opts) => {
    const a = argv[0] === "/usr/bin/taskset" ? argv.slice(3) : argv;
    const has = (x: string) => a.includes(x);
    const val = (x: string) => a[a.indexOf(x) + 1] ?? "";
    const key =
      a[1] === "--version"
        ? "version"
        : has("--lethal-wire-contract-probe")
          ? "bad"
          : has("--test-exact")
            ? val("--test-exact").includes("Space") ? "quoted" : "exact"
            : `cu${val("--codeunit")}${has("--define") ? "-def" : ""}${argv[0] === "/usr/bin/taskset" ? "-shared" : ""}${a.some((x) => x.includes("/broken/")) ? "-broken" : ""}${a.some((x) => x.includes("tests-pinned")) ? "-pinned" : ""}${has("--test-timeout-secs") ? `-n${val("--test-timeout-secs")}` : ""}`;
    const o = over[key]?.(a);
    if (o !== undefined) return { stderr: "", ...o };
    if (has("--coverage-json")) {
      const cov = val("--coverage-json");
      const cu = val("--codeunit");
      const first = "/p/app/src/First.Codeunit.al";
      const body =
        cu === "50650"
          ? {
              coverage: [{ file: first, statements: [{ line: 5, hits: 1 }, { line: 6, hits: 0 }, { line: 7, hits: 1 }] }],
              perTestCoverage: [{ test: "Codeunit50650.CoversOnlyA", coverage: [{ file: first, statements: [{ line: 5, hits: 1 }, { line: 7, hits: 1 }] }] }],
            }
          : {
              coverage: [
                { file: "/p/tests/src/SleepProbe.Codeunit.al", statements: [{ line: 17, hits: 1 }] },
                { file: "/p/app/src/Sleeper.Codeunit.al", statements: [{ line: 5, hits: 1 }] },
              ],
              perTestCoverage: [
                { test: "Codeunit50660.LongSleepA", coverage: [{ file: "/p/tests/src/SleepProbe.Codeunit.al", statements: [{ line: 17, hits: 1 }] }] },
                { test: "Codeunit50660.SleeperDoubles", coverage: [{ file: "/p/app/src/Sleeper.Codeunit.al", statements: [{ line: 5, hits: 1 }] }] },
              ],
            };
      await writeFile(cov, JSON.stringify(body));
    }
    const mainRows = (arm: string) => [
      row(50650, "Passes", "pass"),
      row(50650, "Fails", "fail", { message: "boom 5" }),
      row(50650, "Space Step", "pass"),
      row(50650, "PersistA", "pass"),
      row(50650, "PersistB", "fail", { message: "rows=0 counter=1" }),
      row(50650, "ArmIs", "fail", { message: `arm=${arm}` }),
      row(50650, "CoversOnlyA", "pass"),
    ];
    const sleepRows = [
      row(50660, "ShortSleep", "pass"),
      row(50660, "LongSleepA", "pass"),
      row(50660, "LongSleepB", "pass"),
      row(50660, "LongSleepThenAssert", "fail", { message: "after sleep 3" }),
      row(50660, "SleeperDoubles", "pass"),
    ];
    const answers: Record<string, { exitCode: number; stdout: string; stderr?: string }> = {
      version: { exitCode: 0, stdout: `${VERSION}\n` },
      bad: { exitCode: 2, stdout: "" },
      cu50650: { exitCode: 1, stdout: doc(mainRows("none")), stderr: `target: BC ${BC}, runtime 16.0\n` },
      "cu50650-def": { exitCode: 1, stdout: doc(mainRows("A")) },
      exact: { exitCode: 1, stdout: doc(mainRows("none")) },
      cu0: { exitCode: 6, stdout: "" },
      quoted: { exitCode: 6, stdout: "" },
      "cu50651-n3": { exitCode: 7, stdout: doc([row(50651, "CpuHang", "error", { notRun: true, message: "Test exceeded 3s timeout." })]) },
      "cu50656-n2": { exitCode: 7, stdout: doc([row(50656, "WallSpin3s", "error", { notRun: true, message: "Test exceeded 2s timeout." })]) },
      "cu50656-shared-n2": { exitCode: 0, stdout: doc([row(50656, "WallSpin3s", "pass")]) },
      cu50653: {
        exitCode: 7,
        stdout: doc([
          row(50653, "HttpGet", "error", { notRun: true, message: "NotRun: out-of-scope: an outbound HTTP request" }),
          row(50653, "LaterFails", "error", { notRun: true, message: "NotRun: out-of-scope: an earlier test was refused" }),
        ]),
      },
      cu50657: { exitCode: 7, stdout: doc([row(50657, "CommitCall", "error", { notRun: true, message: "NotRun: out-of-scope: Commit" })]) },
      cu50655: { exitCode: 0, stdout: doc([row(50655, "DuplicateNamedKey", "pass")]) },
      "cu50660-n3": { exitCode: 1, stdout: doc(sleepRows) },
      cu50660: { exitCode: 1, stdout: doc(sleepRows) },
      cu50191: {
        exitCode: 1,
        stdout: doc([
          row(50191, "ProbeMask", "fail", {
            message: `R586MASK:+ALWAYS ${V3_PREDEFINED_CANDIDATES.map((c) => `-${c}`).join(" ")}:END`,
          }),
        ]),
      },
      "cu50650-broken": { exitCode: 7, stdout: doc([row(50650, "Passes", "pass")]) },
      "cu50650-pinned": { exitCode: 1, stdout: doc(mainRows("none")) },
    };
    const ans = answers[key];
    if (ans === undefined) throw new Error(`fake v3: no answer for ${key}: ${argv.join(" ")}`);
    return { stderr: "", ...ans };
  };
}

/** A fake alc that rejects the broken target and compiles everything else. */
const fakeAlcIo: ArtifactIo = {
  spawn: async (argv) => {
    const project = argv.find((a) => a.startsWith("/project:")) ?? "";
    const out = (argv.find((a) => a.startsWith("/out:")) ?? "").slice(5);
    if (project.includes("/broken/")) return { exitCode: 1, stdout: "error AL0118", stderr: "" };
    await writeFile(out, "app");
    return { exitCode: 0, stdout: "", stderr: "" };
  },
  readArtifact: async (p) => new Uint8Array(await Bun.file(p).arrayBuffer()),
  writeArtifact: async (from, to) => {
    const { rename } = await import("node:fs/promises");
    await rename(from, to);
  },
};

const probe = (over: Over = {}): Promise<V3ContractResult> =>
  runV3ContractProbe({
    alRunnerPath: "/fake/alrunner",
    expectedVersion: VERSION,
    packagesDir: "/fake/deps",
    bcVersion: BC,
    alcPath: "/fake/alc",
    alcIo: fakeAlcIo,
    tasksetPath: "/usr/bin/taskset",
    startBurner: () => ({ kill: () => {} }),
    spawn: fakeV3(over),
  });

describe("§8 the contract probe", () => {
  test("alpha.2 as measured: every contract fact matches and every defect is present", async () => {
    const r = await probe();
    const bad = r.facts.filter((f) => f.verdict !== "matches" && f.verdict !== "defect-present");
    expect(bad).toEqual([]);
    expect(v3ContractRefusals(r)).toEqual([]);
    expect(r.facts.map((f) => f.fact).sort()).toEqual(
      [
        "version",
        "unknown-flag-rejected",
        "rows-shape",
        "quoted-name-in-rows",
        "bc-build-pinned",
        "define-honoured",
        "per-test-coverage",
        "codeunit-runs-whole",
        "codeunit-row-equals-exact-row",
        "none-selected-exit",
        "quoted-name-unselectable",
        "timeout-classified",
        "timeout-is-cpu",
        "refusal-row-shape",
        "refusal-cascade",
        "commit-under-test-isolation",
        "duplicate-key-insert-raises",
        "sleep-is-noop",
        "sleep-line-covered",
        "predefined-symbols",
        "compile-failure-not-scorable",
        "upstream-compile-errors",
        "positional-target-wins",
      ].sort(),
    );
  });

  test("a contract fact that diverges refuses (timeout wording moved)", async () => {
    const r = await probe({
      "cu50651-n3": () => ({ exitCode: 7, stdout: doc([row(50651, "CpuHang", "error", { notRun: true, message: "TIMEOUT after 3s" })]) }),
    });
    expect(v3ContractRefusals(r).join("\n")).toMatch(/timeout-classified/);
  });

  test("timeout-is-cpu diverges when the shared-core run is ALSO stopped (a wall-time stop)", async () => {
    const r = await probe({
      "cu50656-shared-n2": () => ({ exitCode: 7, stdout: doc([row(50656, "WallSpin3s", "error", { notRun: true, message: "Test exceeded 2s timeout." })]) }),
    });
    expect(r.facts.find((f) => f.fact === "timeout-is-cpu")?.verdict).toBe("diverged");
  });

  test("a predefined symbol diverges predefined-symbols", async () => {
    const r = await probe({
      cu50191: () => ({
        exitCode: 1,
        stdout: doc([
          row(50191, "ProbeMask", "fail", {
            message: `R586MASK:+ALWAYS ${V3_PREDEFINED_CANDIDATES.map((c) => (c === "CLEAN" ? "+CLEAN" : `-${c}`)).join(" ")}:END`,
          }),
        ]),
      }),
    });
    expect(r.facts.find((f) => f.fact === "predefined-symbols")?.verdict).toBe("diverged");
  });

  test("a defect that is gone never refuses; it prints al-runner-v3-defect-gone", async () => {
    const r = await probe({ cu50655: () => ({ exitCode: 1, stdout: doc([row(50655, "DuplicateNamedKey", "fail", { message: "already exists" })]) }) });
    expect(r.facts.find((f) => f.fact === "duplicate-key-insert-raises")?.verdict).toBe("gone");
    expect(v3ContractRefusals(r)).toEqual([]);
    expect(v3DefectsGone(r).join("\n")).toMatch(/al-runner-v3-defect-gone: duplicate-key-insert-raises/);
  });

  test("sleep-is-noop reads gone when a Sleep test is stopped as a timeout", async () => {
    const r = await probe({
      "cu50660-n3": () => ({ exitCode: 7, stdout: doc([row(50660, "ShortSleep", "error", { notRun: true, message: "Test exceeded 3s timeout." })]) }),
    });
    expect(r.facts.find((f) => f.fact === "sleep-is-noop")?.verdict).toBe("gone");
  });

  test("no taskset leaves timeout-is-cpu unmeasurable, which refuses (a contract fact)", async () => {
    const r = await runV3ContractProbe({
      alRunnerPath: "/fake/alrunner",
      expectedVersion: VERSION,
      packagesDir: "/fake/deps",
      bcVersion: BC,
      alcPath: "/fake/alc",
      alcIo: fakeAlcIo,
      spawn: fakeV3(),
    });
    expect(v3ContractRefusals(r).join("\n")).toMatch(/UNMEASURABLE — timeout-is-cpu/);
  });
});

describe("T18: the .gated pin", () => {
  let dir = "";
  afterEach(async () => {
    if (dir !== "") await rm(dir, { recursive: true, force: true });
  });
  const setup = async (gated?: object) => {
    dir = await mkdtemp(join(tmpdir(), "lethal-r586-pin-"));
    const bin = join(dir, "al-runner");
    await writeFile(bin, "binary bytes");
    if (gated !== undefined) await writeFile(join(dir, ".gated"), JSON.stringify(gated));
    return bin;
  };

  test("a matching .gated passes", async () => {
    const bin = await setup();
    await writeFile(join(dir, ".gated"), JSON.stringify({ version: VERSION, binarySha256: await sha256OfFile(bin), lethalCommit: "abcdef1" }));
    expect((await checkGated(bin, VERSION)).lethalCommit).toBe("abcdef1");
  });

  test("no .gated, another sha256 or another version is refused", async () => {
    const bin = await setup();
    await expect(checkGated(bin, VERSION)).rejects.toBeInstanceOf(AlRunnerV3UngatedBuildError);
    await writeFile(join(dir, ".gated"), JSON.stringify({ version: VERSION, binarySha256: "0".repeat(64), lethalCommit: "abcdef1" }));
    await expect(checkGated(bin, VERSION)).rejects.toThrow(/sha256/);
    await writeFile(join(dir, ".gated"), JSON.stringify({ version: "alrunner 3.0.0-alpha.3 (c893e3633)", binarySha256: await sha256OfFile(bin), lethalCommit: "abcdef1" }));
    await expect(checkGated(bin, VERSION)).rejects.toThrow(/pins/);
  });

  test("a candidate run reads no .gated, and a corrupt .gated is refused, never defaulted", async () => {
    const bin = await setup();
    expect((await checkGated(bin, VERSION, { candidate: true })).binarySha256).toBe(await sha256OfFile(bin));
    expect(() => parseGated("{}", "x")).toThrow(AlRunnerV3UngatedBuildError);
    expect(() => parseGated('{"version":"v","binarySha256":"zz","lethalCommit":"abcdef1"}', "x")).toThrow(/binarySha256/);
  });
});
