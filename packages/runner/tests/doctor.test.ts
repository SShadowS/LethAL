import { describe, expect, test } from "bun:test";
import type { DoctorConfig } from "../src/doctor";
import { runDoctor } from "../src/doctor";

/**
 * Task 4 (C3): a minimal, narrow config — `runDoctor` needs only what decides how to INTERPRET a
 * check's raw signal (today, just the status a reused environment must report — see
 * `DoctorConfig.envReady`'s doc comment). Everything a check needs to OBTAIN its raw signal
 * (server/instance identity, credentials, paths) lives in the injected `deps` closures instead —
 * the real `lethal doctor` CLI wiring builds those from the SAME validated config `lethal run`
 * uses (`validateBcDevConfig` et al.), so a config `run` would reject fails doctor's config-
 * building step too, rather than silently reporting green. See cli.ts's `buildDoctorDeps`.
 */
function cfgFixture(): DoctorConfig {
  return { envReady: "Running" };
}

describe("lethal doctor", () => {
  test("reports every check, not just the first failure", async () => {
    const r = await runDoctor(cfgFixture(), {
      envStatus: async () => "Stopped",
      leaseState: async () => "clear",
      quarantine: async () => "clear",
      controlVersion: async () => "1.0.0.14",
      toolPaths: async () => ({ alc: "ok", altool: "ok" }),
    });
    expect(r.checks.length).toBeGreaterThanOrEqual(5);
    expect(r.ok).toBe(false);
  });

  test("a Stopped environment names the restart command", async () => {
    const r = await runDoctor(cfgFixture(), {
      envStatus: async () => "Stopped",
      leaseState: async () => "clear",
      quarantine: async () => "clear",
      controlVersion: async () => "1.0.0.14",
      toolPaths: async () => ({ alc: "ok", altool: "ok" }),
    });
    const env = r.checks.find((c) => c.name === "environment");
    expect(env?.ok).toBe(false);
    expect(env?.detail).toMatch(/start/i);
  });

  test("all green means ok", async () => {
    const r = await runDoctor(cfgFixture(), {
      envStatus: async () => "Running",
      leaseState: async () => "clear",
      quarantine: async () => "clear",
      controlVersion: async () => "1.0.0.14",
      toolPaths: async () => ({ alc: "ok", altool: "ok" }),
    });
    expect(r.ok).toBe(true);
  });

  // Beyond the brief's three: each check is independently reportable, and a dep that THROWS
  // (a real network failure, not a well-formed "bad" answer) must not blow up the whole report —
  // it is caught and folded into that one check's `ok:false`, exactly like any other failure. This
  // is what makes `runDoctor` read-only-safe to call against a half-broken environment.
  test("a throwing dependency is reported as a failing check, not an uncaught rejection", async () => {
    const r = await runDoctor(cfgFixture(), {
      envStatus: async () => {
        throw new Error("ECONNREFUSED");
      },
      leaseState: async () => "clear",
      quarantine: async () => "clear",
      controlVersion: async () => "1.0.0.14",
      toolPaths: async () => ({ alc: "ok", altool: "ok" }),
    });
    expect(r.ok).toBe(false);
    const env = r.checks.find((c) => c.name === "environment");
    expect(env?.ok).toBe(false);
    expect(env?.detail).toMatch(/ECONNREFUSED/);
    // every OTHER check still ran and still reports green — one dep throwing must not cancel
    // the rest of the report.
    for (const name of ["lease", "quarantine", "control-version", "tool-paths"]) {
      expect(r.checks.find((c) => c.name === name)?.ok).toBe(true);
    }
  });

  test("an unparseable control version is a named failure, not a thrown error", async () => {
    const r = await runDoctor(cfgFixture(), {
      envStatus: async () => "Running",
      leaseState: async () => "clear",
      quarantine: async () => "clear",
      controlVersion: async () => "not-a-version",
      toolPaths: async () => ({ alc: "ok", altool: "ok" }),
    });
    expect(r.ok).toBe(false);
    const cv = r.checks.find((c) => c.name === "control-version");
    expect(cv?.ok).toBe(false);
    expect(cv?.detail).toMatch(/not-a-version/);
  });

  test("a below-minimum control version is reported, naming the rebuild", async () => {
    const r = await runDoctor(cfgFixture(), {
      envStatus: async () => "Running",
      leaseState: async () => "clear",
      quarantine: async () => "clear",
      controlVersion: async () => "1.0.0.0",
      toolPaths: async () => ({ alc: "ok", altool: "ok" }),
    });
    const cv = r.checks.find((c) => c.name === "control-version");
    expect(cv?.ok).toBe(false);
    expect(cv?.detail).toMatch(/rebuild/i);
  });

  test("a missing tool path is named, not just reported false", async () => {
    const r = await runDoctor(cfgFixture(), {
      envStatus: async () => "Running",
      leaseState: async () => "clear",
      quarantine: async () => "clear",
      controlVersion: async () => "1.0.0.14",
      toolPaths: async () => ({ alc: "", altool: "ok" }),
    });
    const tp = r.checks.find((c) => c.name === "tool-paths");
    expect(tp?.ok).toBe(false);
    expect(tp?.detail).toMatch(/alc/);
  });

  test("a held lease/op-marker and a quarantined tier are each reported by name", async () => {
    const r = await runDoctor(cfgFixture(), {
      envStatus: async () => "Running",
      leaseState: async () => "held by another session",
      quarantine: async () => "run: activation deadline exceeded",
      controlVersion: async () => "1.0.0.14",
      toolPaths: async () => ({ alc: "ok", altool: "ok" }),
    });
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === "lease")?.detail).toBe("held by another session");
    expect(r.checks.find((c) => c.name === "quarantine")?.detail).toBe(
      "run: activation deadline exceeded",
    );
  });

  // Read-only: the brief's non-negotiable. `runDoctor` must not mutate anything of its own accord
  // — every dep here is a PLAIN read whose return doctor never uses to trigger a second (mutating)
  // call. Proven structurally: no dep in this suite ever records having been called more than
  // once, and `runDoctor` calls each dep at most once per report.
  test("calls each dependency at most once (never retries into a mutating action)", async () => {
    let envCalls = 0;
    let leaseCalls = 0;
    let quarantineCalls = 0;
    let controlVersionCalls = 0;
    let toolPathsCalls = 0;
    await runDoctor(cfgFixture(), {
      envStatus: async () => {
        envCalls++;
        return "Stopped";
      },
      leaseState: async () => {
        leaseCalls++;
        return "clear";
      },
      quarantine: async () => {
        quarantineCalls++;
        return "clear";
      },
      controlVersion: async () => {
        controlVersionCalls++;
        return "1.0.0.14";
      },
      toolPaths: async () => {
        toolPathsCalls++;
        return { alc: "ok", altool: "ok" };
      },
    });
    expect(envCalls).toBe(1);
    expect(leaseCalls).toBe(1);
    expect(quarantineCalls).toBe(1);
    expect(controlVersionCalls).toBe(1);
    expect(toolPathsCalls).toBe(1);
  });
});
