import { describe, expect, test } from "bun:test";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCobertura } from "../src/al-runner-coverage";
import {
  AL_RUNNER_FRAME_PROBE_TEST,
  FRAME_PROBE_B_START_LINE,
  FRAME_PROBE_EXPECTED_B_LINES,
  FRAME_PROBE_FILE,
  type FrameProbeRefusal,
  probeAlRunnerCoverageFrame,
  writeFrameProbeProject,
} from "../src/al-runner-frame-probe";
import type { SpawnFn } from "../src/publisher";
import { alRunnerStdout } from "./helpers/al-runner-stdout";
import { fakeAlRunnerServer } from "./helpers/fake-al-runner-server";
import { scratchDirs } from "./helpers/scratch";

/**
 * R407 P1/P2: the coverage-frame probe, driven by fake al-runner processes. The positive inputs are
 * the MEASURED 43f76177 captures (`fixtures/r407-frame-probe/`); every negative is that capture
 * changed in ONE way, so each oracle is shown to refuse on its own.
 */

const FIXTURES = join(import.meta.dir, "fixtures", "r407-frame-probe");
const scratch = scratchDirs();
const PASSED = [{ name: AL_RUNNER_FRAME_PROBE_TEST, status: "pass", durationMs: 77 }];

async function project(manifest: Record<string, unknown> = { runtime: "13.0" }): Promise<string> {
  const dir = scratch("lethal-r407-probe-project-");
  await writeFile(join(dir, "app.json"), JSON.stringify(manifest), "utf8");
  return dir;
}

const measuredXml = () => readFile(join(FIXTURES, "oneshot-43f76177.xml"), "utf8");

/** A Cobertura document for the pair file: one class, labelled `label`, with `hits` per line. */
function xmlOf(label: string, rows: readonly (readonly [number, number])[]): string {
  const lines = rows.map(([n, h]) => `<line number="${n}" hits="${h}" />`).join("\n");
  return `<coverage><packages><package name="al-source"><classes><class name="R407Pair.Table" filename="${label}"><lines>\n${lines}\n</lines></class></classes></package></packages></coverage>`;
}

/** The measured rows (line, hits), read from the committed capture. */
async function measuredRows(): Promise<[number, number][]> {
  return parseCobertura(await measuredXml()).map((l) => [l.line, l.hits]);
}

interface OneShotFake {
  readonly calls: { argv: string[]; cwd: string | undefined }[];
  readonly spawn: SpawnFn;
}

/**
 * One fake one-shot al-runner: writes `xml` (with `<root>` replaced by its cwd) to the
 * `--coverage-out` path and reports `tests`. `xml` undefined writes no coverage file.
 */
function oneShot(
  xml: string | undefined,
  tests: readonly Record<string, unknown>[] = PASSED,
  exit?: { exitCode: number; stderr: string },
): OneShotFake {
  const calls: { argv: string[]; cwd: string | undefined }[] = [];
  const spawn: SpawnFn = async (argv, opts) => {
    calls.push({ argv: [...argv], cwd: opts?.cwd });
    if (exit !== undefined) return { exitCode: exit.exitCode, stdout: "", stderr: exit.stderr };
    const out = argv[argv.indexOf("--coverage-out") + 1];
    if (xml !== undefined && out !== undefined) {
      await writeFile(out, xml.replaceAll("<root>", opts?.cwd ?? "<no cwd>"), "utf8");
    }
    return {
      exitCode: tests.every((t) => t.status === "pass") ? 0 : 1,
      stdout: alRunnerStdout({ tests }),
      stderr: "al-runner 2.12.0-main.43f76177 · BC 28.5.54151.55132 · 2 apps\n",
    };
  };
  return { calls, spawn };
}

async function runOneShot(fake: OneShotFake, extra: { platformAppsDir?: string } = {}) {
  return probeAlRunnerCoverageFrame({
    alRunnerPath: "al-runner",
    projectDir: await project(),
    serverMode: false,
    spawn: fake.spawn,
    ...extra,
  });
}

const refusalOf = (r: Awaited<ReturnType<typeof probeAlRunnerCoverageFrame>>) =>
  r.outcome === "refused" ? r.refusal : "admitted";

describe("R407 P1: each oracle refuses on its own (one-shot, synthetic from the measured capture)", () => {
  test("the measured 43f76177 capture is ADMITTED, with its lines, label and build", async () => {
    const fake = oneShot(await measuredXml());
    const r = await runOneShot(fake, { platformAppsDir: "/pin/platform-apps" });
    expect(r).toEqual({
      outcome: "admitted",
      transport: "one-shot",
      build: "al-runner 2.12.0-main.43f76177 · BC 28.5.54151.55132 · 2 apps",
      lines: [45, 46, 47],
      labels: [`inst/active/${FRAME_PROBE_FILE}`],
    });
    // One process, run in the probe root, pinned, asking for exactly the probe test.
    expect(fake.calls).toHaveLength(1);
    const [call] = fake.calls;
    const argv = call?.argv ?? [];
    expect(argv[argv.indexOf("--test") + 1]).toBe(AL_RUNNER_FRAME_PROBE_TEST);
    expect(argv).not.toContain("--auto-provision");
    expect(argv.slice(-2)).toEqual(["--package-cache", "/pin/platform-apps"]);
    expect(argv).toContain(join(call?.cwd ?? "", "inst", "active"));
    expect(argv).toContain(join(call?.cwd ?? "", "tests"));
  });

  const cases: [string, () => Promise<string>, FrameProbeRefusal][] = [
    [
      "correct lines, SOURCE label (path oracle)",
      async () => xmlOf(`src/${FRAME_PROBE_FILE}`, await measuredRows()),
      "label-outside-bundle",
    ],
    [
      "correct lines, BATCH-SIBLING label (path oracle, no trailing-segment match)",
      async () => xmlOf(`inst/batch-1/${FRAME_PROBE_FILE}`, await measuredRows()),
      "label-outside-bundle",
    ],
    [
      "B shifted one line, bundle label (line oracle)",
      async () =>
        xmlOf(
          `inst/active/${FRAME_PROBE_FILE}`,
          (await measuredRows()).map(([n, h]) => [n >= FRAME_PROBE_B_START_LINE ? n + 1 : n, h]),
        ),
      "lines-differ",
    ],
    [
      "B correct plus one stray hit on Probe A (A-silence oracle)",
      async () =>
        xmlOf(
          `inst/active/${FRAME_PROBE_FILE}`,
          (await measuredRows()).map(([n, h]) => [n, n === 25 ? 1 : h]),
        ),
      "first-object-hit",
    ],
  ];
  for (const [name, xml, refusal] of cases) {
    test(`refused: ${name}`, async () => {
      const r = await runOneShot(oneShot(await xml()));
      expect(refusalOf(r)).toBe(refusal);
    });
  }

  test("the c39ad5de mechanism (SOURCE label AND B 12 lines early, into Probe A) is refused", async () => {
    // A ends at line 27 in src and 39 in inst, so c39ad5de's (A's end in the SOURCE) + (distance in
    // the INSTRUMENTED text) reports 45/46/47 as 33/34/35, inside Probe A's trigger.
    const shifted = (await measuredRows()).map(([n, h]): [number, number] => [
      n >= FRAME_PROBE_B_START_LINE ? n - 12 : n,
      h,
    ]);
    const r = await runOneShot(oneShot(xmlOf(`src/${FRAME_PROBE_FILE}`, shifted)));
    expect(r.outcome).toBe("refused");
  });

  test("the expected lines ARE the measured ones (both committed captures)", async () => {
    const oneShotHits = parseCobertura(await measuredXml())
      .filter((l) => l.hits > 0)
      .map((l) => l.line);
    const server = JSON.parse(await readFile(join(FIXTURES, "server-43f76177.json"), "utf8")) as {
      perTestCoverage: { coverage: { statements: { line: number; hits: number }[] }[] }[];
    };
    const serverHits = (server.perTestCoverage[0]?.coverage[0]?.statements ?? [])
      .filter((s) => s.hits > 0)
      .map((s) => s.line);
    expect(oneShotHits).toEqual([...FRAME_PROBE_EXPECTED_B_LINES]);
    expect(serverHits).toEqual([...FRAME_PROBE_EXPECTED_B_LINES]);
  });
});

/**
 * The measured daemon payload as a function of the probe root (the spawn's cwd, known only when
 * the daemon is spawned), optionally relabelled.
 */
async function serverCoverage(
  relabel?: (file: string) => string,
): Promise<(root: string) => unknown[]> {
  const payload = JSON.parse(await readFile(join(FIXTURES, "server-43f76177.json"), "utf8")) as {
    perTestCoverage: { test: string; coverage: { file: string }[] }[];
  };
  return (root) =>
    payload.perTestCoverage.map((p) => ({
      ...p,
      coverage: p.coverage.map((f) => {
        // A NATIVE path, as the daemon writes one on the host's OS: `<root>/a/b` joined with the
        // platform separator. A `/`-joined tail under a `\` root gave Windows two label strings for
        // one file, and a `join`-based relabel that never matched (CI run 37936016083).
        const file = join(root, ...f.file.replace("<root>/", "").split("/"));
        return { ...f, file: relabel !== undefined ? relabel(file) : file };
      }),
    }));
}

describe("R407 P1: the --server probe", () => {
  test("the measured 43f76177 payload is ADMITTED; the daemon runs in the probe root, unpinned", async () => {
    const { result, argvs, cwds, versionCalls } = await runServerWith(await serverCoverage());
    expect(result).toEqual({
      outcome: "admitted",
      transport: "server",
      build:
        "al-runner v2.12.0-main.43f76177 · [bc] selected BC 28.1.49838.54368 (C:/artifacts/28.1.49838.54368)",
      lines: [45, 46, 47],
      labels: [join(cwds[0] ?? "", "inst", "active", FRAME_PROBE_FILE)],
    });
    expect(argvs).toEqual([["al-runner", "--server", "--test-timeout", "60"]]);
    expect(cwds[0]).toContain("lethal-r407-frame-probe-");
    expect(versionCalls).toEqual([["al-runner", "--version"]]);
  });

  test("a SOURCE label on the daemon's absolute path is refused (path oracle)", async () => {
    const { result } = await runServerWith(
      await serverCoverage((f) => f.replace(join("inst", "active"), "src")),
    );
    expect(refusalOf(result)).toBe("label-outside-bundle");
  });
});

/** Runs the server probe with the daemon answering `coverageFor(root)`. */
async function runServerWith(
  coverageFor: (root: string) => unknown[],
  tests: readonly { name: string; status: string }[] = PASSED,
  opts: { silent?: boolean; deadlineMs?: number } = {},
) {
  const versionCalls: string[][] = [];
  const argvs: string[][] = [];
  const cwds: (string | undefined)[] = [];
  const result = await probeAlRunnerCoverageFrame({
    alRunnerPath: "al-runner",
    projectDir: await project(),
    serverMode: true,
    spawn: async (a) => {
      versionCalls.push([...a]);
      return { exitCode: 0, stdout: "al-runner v2.12.0-main.43f76177\n", stderr: "" };
    },
    platformAppsDir: "/pin/never-sent-to-the-daemon",
    serverSpawn: (a, o) => {
      argvs.push([...a]);
      cwds.push(o?.cwd);
      // The coverage names absolute paths under the probe root, which only the cwd tells.
      return fakeAlRunnerServer(tests, {
        silent: opts.silent === true,
        perTestCoverage: coverageFor(o?.cwd ?? ""),
      }).spawn(a, o);
    },
    ...(opts.deadlineMs !== undefined ? { deadlineMs: opts.deadlineMs } : {}),
  });
  return { result, argvs, cwds, versionCalls };
}

describe("R407 P2: an incomplete answer refuses, by name, and never throws", () => {
  test("the probe test failed", async () => {
    const r = await runOneShot(
      oneShot(await measuredXml(), [
        { name: AL_RUNNER_FRAME_PROBE_TEST, status: "fail", message: "Reached(20) must be 21" },
      ]),
    );
    expect(r.outcome === "refused" && [r.refusal, r.reason]).toEqual([
      "test-not-passed",
      `${AL_RUNNER_FRAME_PROBE_TEST} reported "fail": Reached(20) must be 21`,
    ]);
  });

  test("no coverage file was written", async () => {
    expect(refusalOf(await runOneShot(oneShot(undefined)))).toBe("no-coverage");
  });

  test("coverage that never names the pair file", async () => {
    const xml = xmlOf("tests/R407ProbeTests.Codeunit.al", [[10, 1]]);
    expect(refusalOf(await runOneShot(oneShot(xml)))).toBe("no-coverage");
  });

  test("a spawn error / non-verdict exit", async () => {
    const r = await runOneShot(oneShot(undefined, PASSED, { exitCode: 3, stderr: "AL0185" }));
    expect(r.outcome === "refused" && [r.refusal, r.reason]).toEqual(["run-failed", "AL0185"]);
  });

  test("the one-shot deadline is its OWN refusal", async () => {
    const hang: SpawnFn = (_argv, opts) =>
      new Promise((resolve) =>
        // A killed process is reaped LATER than the abort, as Bun's is.
        opts?.signal?.addEventListener("abort", () =>
          setTimeout(() => resolve({ exitCode: 143, stdout: "", stderr: "" }), 10),
        ),
      );
    const r = await probeAlRunnerCoverageFrame({
      alRunnerPath: "al-runner",
      projectDir: await project(),
      serverMode: false,
      spawn: hang,
      deadlineMs: 50,
    });
    expect(refusalOf(r)).toBe("deadline");
  });

  test("the --server deadline is its OWN refusal, and the daemon is closed", async () => {
    const { result } = await runServerWith(() => [], PASSED, {
      silent: true,
      deadlineMs: 200,
    });
    expect(refusalOf(result)).toBe("deadline");
  });

  test("a --server that never starts is run-failed, not a throw", async () => {
    const r = await probeAlRunnerCoverageFrame({
      alRunnerPath: "al-runner",
      projectDir: await project(),
      serverMode: true,
      serverSpawn: () => {
        throw new Error("ENOENT al-runner");
      },
    });
    expect(r.outcome === "refused" && r.refusal).toBe("run-failed");
  });

  test("caller-contract violations throw: no al-runner path, no project app.json", async () => {
    await expect(
      probeAlRunnerCoverageFrame({
        alRunnerPath: "",
        projectDir: await project(),
        serverMode: false,
      }),
    ).rejects.toThrow("no al-runner path");
    await expect(
      probeAlRunnerCoverageFrame({
        alRunnerPath: "al-runner",
        projectDir: scratch("lethal-r407-no-app-json-"),
        serverMode: false,
        spawn: oneShot(undefined).spawn,
      }),
    ).rejects.toThrow("app.json");
  });
});

describe("R407: the probe layout", () => {
  test("src, inst/active and inst/batch-1 share the target id; versions come from the project", async () => {
    const root = scratch("lethal-r407-layout-");
    const proj = await project({ application: "28.0.0.0", platform: "28.0.0.0", runtime: "16.0" });
    await writeFrameProbeProject(root, proj);
    const read = async (p: string) =>
      JSON.parse(await readFile(join(root, p, "app.json"), "utf8")) as Record<string, unknown>;
    const [src, active, batch, tests] = await Promise.all(
      ["src", "inst/active", "inst/batch-1", "tests"].map(read),
    );
    expect(new Set([src?.id, active?.id, batch?.id]).size).toBe(1);
    expect((tests?.dependencies as { id: string }[])[0]?.id).toBe(String(src?.id));
    for (const m of [src, active, batch, tests]) {
      expect([m?.application, m?.platform, m?.runtime]).toEqual(["28.0.0.0", "28.0.0.0", "16.0"]);
    }
    expect(await readdir(join(root, "tests"))).not.toContain(".alpackages");
    // Probe A is LONGER in the bundle than in the source, so a source frame shifts Probe B.
    const srcText = await readFile(join(root, "src", FRAME_PROBE_FILE), "utf8");
    const instText = await readFile(join(root, "inst", "active", FRAME_PROBE_FILE), "utf8");
    expect(instText.split("\n").length - srcText.split("\n").length).toBe(12);
    expect(srcText.startsWith("table ")).toBe(true);
  });
});
