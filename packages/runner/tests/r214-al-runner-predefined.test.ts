import { beforeAll, describe, expect, spyOn, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initParser } from "@lethal/engine";
import { AlRunnerPredefinedProbeError } from "../src/al-runner-predefined-probe";
import type {
  BackendCapabilities,
  BackendStatus,
  ExecutionBackend,
  TestMethodRef,
  TestVerdict,
} from "../src/backend";
import { printDryRun } from "../src/cli";
import type { RunEvent } from "../src/events";
import { type SessionConfig, runSession } from "../src/orchestrator";
import * as symbolsModule from "../src/preprocessor-symbols";
import {
  AL_RUNNER_PREDEFINED_SYMBOLS_V2_12_0,
  type AlRunnerPredefinedProbe,
  predefinedSymbolsHint,
} from "../src/preprocessor-symbols";
import type { SpawnFn } from "../src/publisher";
import * as resumeModule from "../src/resume";
import { ResultsStore } from "../src/store";
import { fakeProbeSpawn, maskFor, probeFailed } from "./helpers/al-runner-predefined";
import { alRunnerStdout } from "./helpers/al-runner-stdout";

/**
 * R214 revise finding 3 (R377): al-runner 2.12.0 predefines CLEANSCHEMA1..CLEANSCHEMA25 when it
 * compiles a project; alc predefines nothing. An al-runner run must enumerate and record under
 * that set, and a bcdev run must not.
 */

// The `Helper` call sites: line 6 is in the `#if not CLEANSCHEMA25` arm (al-runner compiles it
// out), line 8 in its `#else` (al-runner builds it), line 11 in the `#if CLEANSCHEMA26` control
// (neither builds it). Only `void-method-call` mutants are compared: one per call site.
const SOURCE = `codeunit 50013 "CS Probe"
{
    procedure Run(X: Integer)
    begin
#if not CLEANSCHEMA25
        Helper(X);
#else
        Helper(X + 1);
#endif
#if CLEANSCHEMA26
        Helper(X - 1);
#endif
    end;

    local procedure Helper(V: Integer)
    begin
    end;
}
`;

const TEST_AL = `codeunit 50140 "CS Tests"
{
    Subtype = Test;

    [Test]
    procedure RunTest()
    begin
    end;
}
`;

const VOID_CALL = "lethal.void-method-call";
const CLEANSCHEMA_1_TO_25 = Array.from({ length: 25 }, (_, i) => `CLEANSCHEMA${i + 1}`).sort();

/** R392: a probe that measured `symbols` (the v2.12.0 list unless told otherwise). */
const probeOf =
  (symbols: readonly string[] = AL_RUNNER_PREDEFINED_SYMBOLS_V2_12_0) =>
  async (): Promise<AlRunnerPredefinedProbe> => ({ symbols: [...symbols].sort() });

class StubBackend implements ExecutionBackend {
  private active: string | null = null;
  constructor(
    private readonly authoritative: boolean,
    private readonly probe: (pin?: string) => Promise<AlRunnerPredefinedProbe> = probeOf(),
  ) {}
  capabilities(): BackendCapabilities {
    return {
      coverage: "procedure",
      deploy: "publish",
      isolation: "session",
      authoritative: this.authoritative,
    };
  }
  async status(): Promise<BackendStatus> {
    return { ok: true, details: "stub" };
  }
  /** R392: the structural method runSession asks an al-runner backend to measure with. */
  measurePredefinedSymbols(pin?: string): Promise<AlRunnerPredefinedProbe> {
    return this.probe(pin);
  }
  async deploy(): Promise<null> {
    return null;
  }
  async compileCheck(): Promise<void> {}
  async activate(id: string | null): Promise<void> {
    this.active = id;
  }
  async run(ref: TestMethodRef): Promise<TestVerdict> {
    return {
      ref,
      outcome: "pass",
      durationMs: 5,
      ...(this.active === null
        ? {
            coverage: {
              granularity: "procedure" as const,
              entries: [{ objectType: "Codeunit", objectId: 50013, procedure: "Run" }],
            },
          }
        : { attestation: { observedAny: true, identityMismatch: false } }),
    };
  }
}

beforeAll(async () => {
  await initParser();
});

async function withProject<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "lethal-r377-"));
  try {
    await Bun.write(
      join(root, "app", "app.json"),
      JSON.stringify({
        id: "11111111-2222-3333-4444-555555555555",
        name: "p",
        publisher: "x",
        version: "1.0.0.0",
      }),
    );
    await Bun.write(join(root, "app", "src", "Probe.Codeunit.al"), SOURCE);
    await Bun.write(join(root, "tests", "CsTests.Codeunit.al"), TEST_AL);
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const session = (
  root: string,
  store: ResultsStore,
  authoritative: boolean,
  extra: Partial<SessionConfig> = {},
) =>
  runSession({
    backend: new StubBackend(authoritative),
    store,
    projectDir: join(root, "app"),
    testDir: join(root, "tests"),
    instrumentedDir: join(root, authoritative ? "instr-bc" : "instr-ar"),
    selectorIds: { selectorId: 50147, controlId: 50148, tableId: 50149 },
    ...extra,
  });

const linesOf = (report: Awaited<ReturnType<typeof session>>) =>
  report.mutants
    .filter((m) => m.operatorName === VOID_CALL)
    .map((m) => m.line)
    .sort((a, b) => a - b);

describe("R377: al-runner's predefined CLEANSCHEMA1..25", () => {
  test("the v2.12.0 constant is exactly CLEANSCHEMA1..CLEANSCHEMA25", () => {
    expect([...AL_RUNNER_PREDEFINED_SYMBOLS_V2_12_0].sort()).toEqual(CLEANSCHEMA_1_TO_25);
  });

  test("predefinedSymbolsHint fires only when the sets differ by exactly the predefines", () => {
    const hint = " (al-runner v2.12.0 predefines CLEANSCHEMA1..CLEANSCHEMA25, R377)";
    const p = AL_RUNNER_PREDEFINED_SYMBOLS_V2_12_0;
    expect(predefinedSymbolsHint([], p)).toBe(hint);
    expect(predefinedSymbolsHint([...p, "X"], ["X"])).toBe(hint);
    expect(predefinedSymbolsHint(["X"], p)).toBe("");
    expect(predefinedSymbolsHint(["X"], ["Y"])).toBe("");
    expect(predefinedSymbolsHint(null, p)).toBe("");
  });

  test("an al-runner run builds only al-runner's arms and records its set; bcdev keeps alc's", async () => {
    await withProject(async (root) => {
      const store = new ResultsStore(":memory:");
      const ar = await session(root, store, false);
      expect(linesOf(ar)).toEqual([8]);
      const arRow = store.getRun(1);
      expect(arRow?.backend).toBe("al-runner");
      expect(arRow?.buildSymbols).toEqual(CLEANSCHEMA_1_TO_25);
      expect(arRow?.buildSymbols).not.toContain("CLEANSCHEMA26");
      const out = (ar.excludedSites?.files ?? []).find((f) => f.reason === "compiled-out");
      expect(out?.detail).toBe(`symbols: ${CLEANSCHEMA_1_TO_25.join(", ")}`);

      const bc = await session(root, store, true);
      expect(linesOf(bc)).toEqual([6]);
      const bcRow = store.getRun(2);
      expect(bcRow?.backend).toBe("bcdev");
      expect(bcRow?.buildSymbols).toEqual([]);

      // History: the latest finished (bcdev) run is not history for an al-runner build. The stub
      // reads no test app, so both rows get one hash here, leaving the symbols as the only
      // difference `priorSurvivorKeys` can refuse on; the bcdev set is the control.
      const db = (
        store as unknown as {
          db: { run(sql: string): void; query(sql: string): { get(): unknown } };
        }
      ).db;
      const natural = db.query("SELECT test_app_hash AS h FROM runs WHERE id = 2").get() as {
        h: string | null;
      };
      db.run("UPDATE runs SET test_app_hash = 'same-test-app'");
      const refusedOnSymbols = (symbols: readonly string[]) => {
        let changed = false;
        store.priorSurvivorKeys(join(root, "app"), "procedure", "same-test-app", symbols, {
          symbolsChanged: () => {
            changed = true;
          },
        });
        return changed;
      };
      expect([refusedOnSymbols(CLEANSCHEMA_1_TO_25), refusedOnSymbols([])]).toEqual([true, false]);

      // The history warning names the al-runner predefines when they are the whole difference.
      // Put run 2's own test-app hash back, so the symbols are the only thing the session can refuse on.
      db.run(`UPDATE runs SET test_app_hash = ${natural.h === null ? "NULL" : `'${natural.h}'`}`);
      const events: RunEvent[] = [];
      await runSession({
        backend: new StubBackend(false),
        store,
        projectDir: join(root, "app"),
        testDir: join(root, "tests"),
        instrumentedDir: join(root, "instr-ar"),
        selectorIds: { selectorId: 50147, controlId: 50148, tableId: 50149 },
        skipKnownSurvivors: true,
        emit: [(e) => events.push(e)],
      });
      const warned = events.find(
        (e) => e.type === "warning" && e.code === "history-build-symbols-changed",
      );
      expect(warned && "message" in warned ? warned.message : "").toMatch(
        /was built with preprocessor symbols \(none\), and this build uses CLEANSCHEMA1,.*\(al-runner v2\.12\.0 predefines CLEANSCHEMA1\.\.CLEANSCHEMA25, R377\)\. /,
      );
      // A match with the v2.12.0 list is silent (R392).
      expect(events.some((e) => e.type === "warning" && e.code === CHANGED)).toBe(false);
      store.close();
    });
  }, 60_000);

  test("--dry-run --backend al-runner lists al-runner's arms; without it, alc's", async () => {
    await withProject(async (root) => {
      // R392: the al-runner listing probes al-runner once; the others never spawn anything.
      const spawned: string[][] = [];
      const fake = fakeProbeSpawn(probeFailed(maskFor(new Set(CLEANSCHEMA_1_TO_25))));
      const spawn: SpawnFn = async (argv, opts) => {
        spawned.push([...argv]);
        return fake.spawn(argv, opts);
      };
      const listing = async (backendKind?: "al-runner" | "bcdev") => {
        const outPath = join(root, `dry-${backendKind ?? "none"}.json`);
        await printDryRun(
          join(root, "app"),
          undefined,
          {
            dbPath: join(root, "none.sqlite"),
            configPath: join(root, "none.json"),
            outPath,
            alRunnerPath: "fake-al-runner",
            ...(backendKind !== undefined ? { backendKind } : {}),
          },
          spawn,
        );
        const j = JSON.parse(await readFile(outPath, "utf8")) as {
          batches: { sites: { line: number; operator: string }[] }[];
        };
        return j.batches
          .flatMap((b) => b.sites)
          .filter((s) => s.operator === VOID_CALL)
          .map((s) => s.line)
          .sort((a, b) => a - b);
      };
      expect(await listing(undefined)).toEqual([6]);
      expect(await listing("bcdev")).toEqual([6]);
      expect(spawned).toHaveLength(0);
      expect(await listing("al-runner")).toEqual([8]);
      expect(spawned).toHaveLength(1);
    });
  }, 60_000);

  test("--dry-run --backend al-runner lists the MEASURED set's arms, with the named warning", async () => {
    await withProject(async (root) => {
      const measured = new Set([...CLEANSCHEMA_1_TO_25, "CLEANSCHEMA26"]);
      measured.delete("CLEANSCHEMA25");
      const outPath = join(root, "dry-measured.json");
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        await printDryRun(
          join(root, "app"),
          undefined,
          {
            dbPath: join(root, "none.sqlite"),
            configPath: join(root, "none.json"),
            outPath,
            alRunnerPath: "fake-al-runner",
            backendKind: "al-runner",
          },
          fakeProbeSpawn(probeFailed(maskFor(measured))).spawn,
        );
        expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
          "added [CLEANSCHEMA26], removed [CLEANSCHEMA25]",
        );
      } finally {
        warn.mockRestore();
      }
      const j = JSON.parse(await readFile(outPath, "utf8")) as {
        batches: { sites: { line: number; operator: string }[] }[];
      };
      const lines = j.batches
        .flatMap((b) => b.sites)
        .filter((s) => s.operator === VOID_CALL)
        .map((s) => s.line)
        .sort((a, b) => a - b);
      expect(lines).toEqual([6, 11]);
    });
  }, 60_000);

  test("--dry-run --backend al-runner refuses an incomplete probe and a missing al-runner path", async () => {
    await withProject(async (root) => {
      const base = {
        dbPath: join(root, "none.sqlite"),
        configPath: join(root, "none.json"),
        backendKind: "al-runner" as const,
      };
      await expect(
        printDryRun(
          join(root, "app"),
          undefined,
          { ...base, alRunnerPath: "fake-al-runner" },
          fakeProbeSpawn(probeFailed("BOOM")).spawn,
        ),
      ).rejects.toBeInstanceOf(AlRunnerPredefinedProbeError);
      await expect(printDryRun(join(root, "app"), undefined, base)).rejects.toThrow(
        /alRunnerPath.*R392|R392.*alRunnerPath/,
      );
    });
  }, 60_000);

  // printDryRun is called directly above, so it cannot see main() drop `--backend` or the config's
  // al-runner path on the way. Both refusals below are R392's, by name; they differ in whether
  // main() forwarded a path (a probe was attempted) or had none to forward.
  test("`lethal run --dry-run --backend al-runner` through main() probes, or refuses by name", async () => {
    await withProject(async (root) => {
      const cli = join(import.meta.dir, "..", "src", "cli.ts");
      const dryRun = async (configArgs: string[]) => {
        const proc = Bun.spawn(
          [
            "bun",
            cli,
            "run",
            "--project",
            join(root, "app"),
            "--dry-run",
            "--backend",
            "al-runner",
            "--db",
            join(root, "lethal.sqlite"),
            ...configArgs,
          ],
          { stdout: "pipe", stderr: "pipe", env: process.env },
        );
        const stderr = await new Response(proc.stderr).text();
        return { code: await proc.exited, stderr };
      };
      const empty = join(root, "empty.config.json");
      await Bun.write(empty, "{}");
      const noPath = await dryRun(["--config", empty]);
      expect(noPath.code).not.toBe(0);
      expect(noPath.stderr).toMatch(/alRunnerPath/);
      expect(noPath.stderr).toContain("R392");

      const config = join(root, "lethal.config.json");
      await Bun.write(
        config,
        JSON.stringify({ alRunner: { alRunnerPath: join(root, "no-such-al-runner.exe") } }),
      );
      const probed = await dryRun(["--config", config]);
      expect(probed.code).not.toBe(0);
      expect(probed.stderr).toContain("could not measure al-runner's predefined");
    });
  }, 60_000);

  // R392 review r1: the SUCCESS path through main(). The al-runner is a tiny script that prints the
  // probe's failing result, so main() forwards the config's path, the probe runs, and the listing prints.
  test("`lethal run --dry-run --backend al-runner` through main() succeeds with a probe that answers", async () => {
    await withProject(async (root) => {
      const cli = join(import.meta.dir, "..", "src", "cli.ts");
      const answer = join(root, "probe-answer.txt");
      await Bun.write(
        answer,
        alRunnerStdout({ tests: probeFailed(maskFor(new Set(CLEANSCHEMA_1_TO_25))) }),
      );
      const win = process.platform === "win32";
      const fake = join(root, win ? "fake-al-runner.cmd" : "fake-al-runner.sh");
      await Bun.write(
        fake,
        win ? `@type "${answer}"\r\n@exit /b 1\r\n` : `#!/bin/sh\ncat "${answer}"\nexit 1\n`,
      );
      if (!win) await chmod(fake, 0o755);
      const config = join(root, "lethal.config.json");
      await Bun.write(config, JSON.stringify({ alRunner: { alRunnerPath: fake } }));
      const proc = Bun.spawn(
        [
          "bun",
          cli,
          "run",
          "--project",
          join(root, "app"),
          "--dry-run",
          "--backend",
          "al-runner",
          "--db",
          join(root, "lethal.sqlite"),
          "--config",
          config,
        ],
        { stdout: "pipe", stderr: "pipe", env: process.env },
      );
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      expect(await proc.exited, stderr).toBe(0);
      expect(stderr).not.toContain("R392");
      expect(stdout).toMatch(/mutants?/i);
    });
  }, 60_000);
});

describe("R392: runSession measures al-runner's predefined symbols", () => {
  test("order: probe (finished) -> effectiveBuildSymbols -> fingerprint -> generation", async () => {
    await withProject(async (root) => {
      const order: string[] = [];
      // Counters on the real calls (spied on the module namespaces runSession imports from).
      const realEffective = symbolsModule.effectiveBuildSymbols;
      const realFingerprint = resumeModule.sessionFingerprint;
      const effective = spyOn(symbolsModule, "effectiveBuildSymbols").mockImplementation(
        (...args) => {
          order.push(`effectiveBuildSymbols:${JSON.stringify(args[3])}`);
          return realEffective(...args);
        },
      );
      const fingerprint = spyOn(resumeModule, "sessionFingerprint").mockImplementation((input) => {
        order.push("sessionFingerprint");
        return realFingerprint(input);
      });
      const store = new ResultsStore(":memory:");
      // The probe waits on a promise this test releases, so "finished first" does not rest on a timer.
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => {
        release = r;
      });
      let started: () => void = () => {};
      const probeStarted = new Promise<void>((r) => {
        started = r;
      });
      try {
        const running = session(root, store, false, {
          backend: new StubBackend(false, async () => {
            order.push("probe:start");
            started();
            await gate;
            order.push("probe:end");
            return { symbols: [...CLEANSCHEMA_1_TO_25] };
          }),
          emit: [
            (e) => {
              if (e.type === "phase-entered" && e.phase === "generate") order.push("generate");
            },
          ],
        });
        await probeStarted;
        // Let everything that is not waiting on the probe run. A fire-and-forget probe would have
        // reached effectiveBuildSymbols by now.
        for (let i = 0; i < 200; i++) await new Promise((r) => setImmediate(r));
        expect(order.some((o) => o.startsWith("effectiveBuildSymbols"))).toBe(false);
        release();
        await running;
      } finally {
        release();
        effective.mockRestore();
        fingerprint.mockRestore();
        store.close();
      }
      const probed = JSON.stringify({
        kind: "al-runner",
        predefined: { symbols: CLEANSCHEMA_1_TO_25 },
      });
      // The second effectiveBuildSymbols call is generateMutationSet's own, after `generate`.
      expect(order).toEqual([
        "probe:start",
        "probe:end",
        `effectiveBuildSymbols:${probed}`,
        "sessionFingerprint",
        "generate",
        `effectiveBuildSymbols:${probed}`,
      ]);
    });
  }, 60_000);

  test("a mismatch uses the MEASURED set everywhere and emits the named warning", async () => {
    await withProject(async (root) => {
      const measured = [
        ...CLEANSCHEMA_1_TO_25.filter((s) => s !== "CLEANSCHEMA25"),
        "CLEANSCHEMA26",
      ];
      const store = new ResultsStore(":memory:");
      const events: RunEvent[] = [];
      const report = await session(root, store, false, {
        backend: new StubBackend(false, probeOf(measured)),
        emit: [(e) => events.push(e)],
      });
      // `#if not CLEANSCHEMA25` (line 6) and `#if CLEANSCHEMA26` (line 11) are now built.
      expect(linesOf(report)).toEqual([6, 11]);
      expect(store.getRun(1)?.buildSymbols).toEqual([...measured].sort());
      const warned = events.find((e) => e.type === "warning" && e.code === CHANGED);
      expect(warned && "message" in warned ? warned.message : "").toContain(
        "added [CLEANSCHEMA26], removed [CLEANSCHEMA25]",
      );
      store.close();
    });
  }, 60_000);

  test("a probe refusal refuses the run before any run row exists", async () => {
    await withProject(async (root) => {
      const store = new ResultsStore(":memory:");
      await expect(
        session(root, store, false, {
          backend: new StubBackend(false, async () => {
            throw new AlRunnerPredefinedProbeError("candidate(s) missing", "tail");
          }),
        }),
      ).rejects.toBeInstanceOf(AlRunnerPredefinedProbeError);
      expect(store.getRun(1)).toBeNull();
      store.close();
    });
  }, 60_000);

  test("an al-runner backend that cannot measure refuses by name", async () => {
    await withProject(async (root) => {
      const store = new ResultsStore(":memory:");
      const backend = new StubBackend(false);
      Object.defineProperty(backend, "measurePredefinedSymbols", { value: undefined });
      await expect(session(root, store, false, { backend })).rejects.toThrow(
        /measurePredefinedSymbols.*R392/,
      );
      store.close();
    });
  }, 60_000);

  test("the probe is handed the directory provisioning reported, even when the pin is declined", async () => {
    await withProject(async (root) => {
      const store = new ResultsStore(":memory:");
      const pins: Array<string | undefined> = [];
      const backend = Object.assign(
        new StubBackend(false, async (pin) => {
          pins.push(pin);
          return { symbols: [...CLEANSCHEMA_1_TO_25] };
        }),
        {
          provisionOnce: async () => ({
            ran: true,
            downloaded: false,
            elapsedMs: 1,
            detail: "",
            platformAppsDir: "C:/pin",
          }),
          usePlatformAppsDir: () => false,
        },
      );
      await session(root, store, false, { backend });
      expect(pins).toEqual(["C:/pin"]);
      store.close();
    });
  }, 60_000);

  test("bcdev never probes", async () => {
    await withProject(async (root) => {
      const store = new ResultsStore(":memory:");
      let calls = 0;
      await session(root, store, true, {
        backend: new StubBackend(true, async () => {
          calls++;
          return { symbols: [] };
        }),
      });
      expect(calls).toBe(0);
      store.close();
    });
  }, 60_000);
});

const CHANGED = "al-runner-predefined-symbols-changed";
