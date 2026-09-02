import { describe, expect, test } from "bun:test";
import type { DoctorConfig } from "../src/doctor";
import { runDoctor } from "../src/doctor";
// R110: the fixtures track MIN_CONTROL_VERSION rather than pinning a literal, so a version bump
// cannot silently turn every green fixture red — it did exactly that when 1.0.0.15 landed.
import { MIN_CONTROL_VERSION } from "../src/harness";

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

/**
 * R131: a machine with no al-runner cache. Every fixture below uses it, because the cache check
 * reports a local disk fact that has nothing to do with what these tests are about — and a fixture
 * reading the REAL `~/.local/share/al-runner` would make these tests depend on whoever ran a gate
 * last. The check's own behaviour is tested in `al-runner-cache.test.ts`.
 */
const EMPTY_CACHE = {
  dir: "/nonexistent",
  present: false,
  totalBytes: 0,
  builds: [],
  secondaryBytes: null,
  secondaryDir: "/nonexistent-cache",
} as const;

describe("lethal doctor", () => {
  test("reports every check, not just the first failure", async () => {
    const r = await runDoctor(cfgFixture(), {
      envStatus: async () => "Stopped",
      quarantine: async () => "clear",
      controlVersion: async () => MIN_CONTROL_VERSION,
      toolPaths: async () => ({ alc: "ok", altool: "ok" }),
      alRunnerCache: async () => EMPTY_CACHE,
    });
    // Review round 1: was `>= 5` — the `lease` check shipped in round 0 but was REMOVED (a check
    // that structurally could not fail was counted as a pass; see `DOCTOR_NOT_CHECKED` in cli.ts
    // and roadmap R110). Four remain: environment, quarantine, control-version, tool-paths.
    expect(r.checks.length).toBeGreaterThanOrEqual(4);
    expect(r.ok).toBe(false);
  });

  test("a Stopped environment names the restart command", async () => {
    const r = await runDoctor(cfgFixture(), {
      envStatus: async () => "Stopped",
      quarantine: async () => "clear",
      controlVersion: async () => MIN_CONTROL_VERSION,
      toolPaths: async () => ({ alc: "ok", altool: "ok" }),
      alRunnerCache: async () => EMPTY_CACHE,
    });
    const env = r.checks.find((c) => c.name === "environment");
    expect(env?.ok).toBe(false);
    expect(env?.detail).toMatch(/start/i);
  });

  test("all green means ok", async () => {
    const r = await runDoctor(cfgFixture(), {
      envStatus: async () => "Running",
      quarantine: async () => "clear",
      controlVersion: async () => MIN_CONTROL_VERSION,
      toolPaths: async () => ({ alc: "ok", altool: "ok" }),
      alRunnerCache: async () => EMPTY_CACHE,
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
      quarantine: async () => "clear",
      controlVersion: async () => MIN_CONTROL_VERSION,
      toolPaths: async () => ({ alc: "ok", altool: "ok" }),
      alRunnerCache: async () => EMPTY_CACHE,
    });
    expect(r.ok).toBe(false);
    const env = r.checks.find((c) => c.name === "environment");
    expect(env?.ok).toBe(false);
    expect(env?.detail).toMatch(/ECONNREFUSED/);
    // every OTHER check still ran and still reports green — one dep throwing must not cancel
    // the rest of the report.
    for (const name of ["quarantine", "control-version", "tool-paths"]) {
      expect(r.checks.find((c) => c.name === name)?.ok).toBe(true);
    }
  });

  test("an unparseable control version is a named failure, not a thrown error", async () => {
    const r = await runDoctor(cfgFixture(), {
      envStatus: async () => "Running",
      quarantine: async () => "clear",
      controlVersion: async () => "not-a-version",
      toolPaths: async () => ({ alc: "ok", altool: "ok" }),
      alRunnerCache: async () => EMPTY_CACHE,
    });
    expect(r.ok).toBe(false);
    const cv = r.checks.find((c) => c.name === "control-version");
    expect(cv?.ok).toBe(false);
    expect(cv?.detail).toMatch(/not-a-version/);
  });

  test("a below-minimum control version is reported, naming the rebuild", async () => {
    const r = await runDoctor(cfgFixture(), {
      envStatus: async () => "Running",
      quarantine: async () => "clear",
      controlVersion: async () => "1.0.0.0",
      toolPaths: async () => ({ alc: "ok", altool: "ok" }),
      alRunnerCache: async () => EMPTY_CACHE,
    });
    const cv = r.checks.find((c) => c.name === "control-version");
    expect(cv?.ok).toBe(false);
    expect(cv?.detail).toMatch(/rebuild/i);
  });

  test("a missing tool path is named, not just reported false", async () => {
    const r = await runDoctor(cfgFixture(), {
      envStatus: async () => "Running",
      quarantine: async () => "clear",
      controlVersion: async () => MIN_CONTROL_VERSION,
      toolPaths: async () => ({ alc: "", altool: "ok" }),
      alRunnerCache: async () => EMPTY_CACHE,
    });
    const tp = r.checks.find((c) => c.name === "tool-paths");
    expect(tp?.ok).toBe(false);
    expect(tp?.detail).toMatch(/alc/);
  });

  // Review round 1: `altoolRequired` (default true) lets an env-tool-configured project — which
  // never spawns altool (`buildBackend`'s `envToolDeploy !== undefined` branch, cli.ts) — pass
  // with no altool resolved, matching `run`'s own leniency instead of being stricter than it.
  test("altool is not required when the config says so (env-tool publish route)", async () => {
    const r = await runDoctor(
      { ...cfgFixture(), altoolRequired: false },
      {
        envStatus: async () => "Running",
        quarantine: async () => "clear",
        controlVersion: async () => MIN_CONTROL_VERSION,
        toolPaths: async () => ({ alc: "ok", altool: "" }),
        alRunnerCache: async () => EMPTY_CACHE,
      },
    );
    const tp = r.checks.find((c) => c.name === "tool-paths");
    expect(tp?.ok).toBe(true);
  });

  test("a quarantined tier is reported by name", async () => {
    const r = await runDoctor(cfgFixture(), {
      envStatus: async () => "Running",
      quarantine: async () => "run: activation deadline exceeded",
      controlVersion: async () => MIN_CONTROL_VERSION,
      toolPaths: async () => ({ alc: "ok", altool: "ok" }),
      alRunnerCache: async () => EMPTY_CACHE,
    });
    expect(r.ok).toBe(false);
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
    let quarantineCalls = 0;
    let controlVersionCalls = 0;
    let toolPathsCalls = 0;
    let cacheCalls = 0;
    await runDoctor(cfgFixture(), {
      envStatus: async () => {
        envCalls++;
        return "Stopped";
      },
      quarantine: async () => {
        quarantineCalls++;
        return "clear";
      },
      controlVersion: async () => {
        controlVersionCalls++;
        return MIN_CONTROL_VERSION;
      },
      toolPaths: async () => {
        toolPathsCalls++;
        return { alc: "ok", altool: "ok" };
      },
      alRunnerCache: async () => {
        cacheCalls++;
        return EMPTY_CACHE;
      },
    });
    expect(envCalls).toBe(1);
    expect(quarantineCalls).toBe(1);
    expect(controlVersionCalls).toBe(1);
    expect(toolPathsCalls).toBe(1);
    expect(cacheCalls).toBe(1);
  });
});

/**
 * R110 — `lethal doctor`'s lease check, restored.
 *
 * Its first implementation was WITHDRAWN in review: it returned `"clear"` unconditionally, so it
 * could not fail on any input, rendered as `[ok]`, and was confidently green in exactly the
 * stranded-lease scenario the recovery tooling exists for. The row's acceptance criterion is
 * therefore not "the check exists" but "a held lease makes doctor non-green" — the property the
 * withdrawn check could not have had.
 */
describe("lethal doctor — the lease check (R110)", () => {
  const green = {
    envStatus: async () => "Running",
    quarantine: async () => "clear",
    controlVersion: async () => MIN_CONTROL_VERSION,
    toolPaths: async () => ({ alc: "ok", altool: "ok" }),
    alRunnerCache: async () => EMPTY_CACHE,
  };
  // A cleanly RELEASED lease, not a virgin one: `TryRelease` leaves `Owner` populated, which is
  // the shape a healthy container actually presents and the one an owner-keyed check got wrong.
  const idle = { owner: "lethal-run-41", opKind: "none", expiresAt: "", tokenPresent: false };
  const NOW = new Date("2026-08-07T12:00:00.000Z");

  test("A HELD LEASE MAKES DOCTOR NON-GREEN — the property the withdrawn check could not have", async () => {
    const r = await runDoctor(
      { ...cfgFixture(), now: NOW },
      {
        ...green,
        lease: async () => ({
          owner: "lethal-run-42",
          opKind: "run",
          expiresAt: "2026-08-07T12:05:00.000Z",
          tokenPresent: true,
        }),
      },
    );
    expect(r.ok).toBe(false);
    const lease = r.checks.find((c) => c.name === "lease");
    expect(lease?.ok).toBe(false);
    expect(lease?.detail).toContain("lethal-run-42");
    expect(lease?.detail).toContain("run");
    expect(lease?.detail).toContain("force-reset-lease");
  });

  test("an idle lease passes, and everything else green stays green", async () => {
    const r = await runDoctor({ ...cfgFixture(), now: NOW }, { ...green, lease: async () => idle });
    expect(r.ok).toBe(true);
    expect(r.checks.find((c) => c.name === "lease")?.detail).toContain("no lease held");
  });

  test("an EXPIRED holder is called an orphan — a live one is not", async () => {
    // Different work: an expired holder means recover, a live one usually means wait. Collapsing
    // the two would send an operator to force-reset a lease a running session still owns.
    const expired = await runDoctor(
      { ...cfgFixture(), now: NOW },
      {
        ...green,
        lease: async () => ({
          owner: "x",
          opKind: "run",
          expiresAt: "2026-08-07T11:00:00.000Z",
          tokenPresent: true,
        }),
      },
    );
    const live = await runDoctor(
      { ...cfgFixture(), now: NOW },
      {
        ...green,
        lease: async () => ({
          owner: "x",
          opKind: "run",
          expiresAt: "2026-08-07T13:00:00.000Z",
          tokenPresent: true,
        }),
      },
    );
    expect(expired.checks.find((c) => c.name === "lease")?.detail).toContain("ALREADY EXPIRED");
    expect(expired.checks.find((c) => c.name === "lease")?.detail).toContain("orphaned");
    expect(live.checks.find((c) => c.name === "lease")?.detail).not.toContain("EXPIRED");
    expect(live.checks.find((c) => c.name === "lease")?.detail).not.toContain("orphaned");
  });

  test("an op marker with NO owner still fails — that is what a killed session leaves", async () => {
    // Green requires BOTH halves. Keying only on `owner` would pass the exact shape the recovery
    // tooling exists for.
    const r = await runDoctor(
      { ...cfgFixture(), now: NOW },
      {
        ...green,
        lease: async () => ({ owner: "", opKind: "publish", expiresAt: "", tokenPresent: false }),
      },
    );
    expect(r.checks.find((c) => c.name === "lease")?.ok).toBe(false);
    expect(r.checks.find((c) => c.name === "lease")?.detail).toContain("no owner recorded");
  });

  test("is skipped entirely when the dep is absent (create mode), never faked green", async () => {
    const r = await runDoctor(cfgFixture(), green);
    expect(r.checks.some((c) => c.name === "lease")).toBe(false);
    expect(r.ok).toBe(true);
  });

  test("calls the lease dep at most once — it is a READ, never a probe-by-acquiring", async () => {
    let calls = 0;
    await runDoctor(
      { ...cfgFixture(), now: NOW },
      {
        ...green,
        lease: async () => {
          calls++;
          return idle;
        },
      },
    );
    expect(calls).toBe(1);
  });
});

/**
 * R195. Measured 2026-09-02: a config named `CRONUS Danmark A/S` against a sandbox holding
 * `CRONUS UK Ltd.`, and doctor's only word on it was BC's 404 under `control-version`, naming the
 * configured value and nothing else. The check exists to name what DOES exist, and to do so before
 * the checks that need a company fail for the same reason.
 */
describe("lethal doctor — the company check (R195)", () => {
  const live = {
    envStatus: async () => "Running",
    quarantine: async () => "clear",
    controlVersion: async () => MIN_CONTROL_VERSION,
    toolPaths: async () => ({ alc: "ok", altool: "ok" }),
    alRunnerCache: async () => EMPTY_CACHE,
  };

  test("a company the server has passes, naming it", async () => {
    const r = await runDoctor(cfgFixture(), {
      ...live,
      companies: async () => ({
        configured: "CRONUS UK Ltd.",
        names: ["CRONUS UK Ltd.", "My Company"],
      }),
    });
    const c = r.checks.find((x) => x.name === "company");
    expect(c?.ok).toBe(true);
    expect(c?.detail).toContain('"CRONUS UK Ltd." exists');
    expect(r.ok).toBe(true);
  });

  test("a company the server does NOT have fails and lists the ones it has", async () => {
    const r = await runDoctor(cfgFixture(), {
      ...live,
      companies: async () => ({
        configured: "CRONUS Danmark A/S",
        names: ["CRONUS UK Ltd.", "My Company"],
      }),
    });
    const c = r.checks.find((x) => x.name === "company");
    expect(c?.ok).toBe(false);
    expect(c?.detail).toContain('"CRONUS Danmark A/S" does not exist');
    expect(c?.detail).toContain('"CRONUS UK Ltd."');
    expect(c?.detail).toContain('"My Company"');
    expect(r.ok).toBe(false);
  });

  test("a name that differs only in case passes and shows the server's spelling", async () => {
    const r = await runDoctor(cfgFixture(), {
      ...live,
      companies: async () => ({ configured: "cronus uk ltd.", names: ["CRONUS UK Ltd."] }),
    });
    const c = r.checks.find((x) => x.name === "company");
    expect(c?.ok).toBe(true);
    expect(c?.detail).toContain('exists as "CRONUS UK Ltd."');
  });

  test("a server reporting no companies at all fails and says so", async () => {
    const r = await runDoctor(cfgFixture(), {
      ...live,
      companies: async () => ({ configured: "CRONUS", names: [] }),
    });
    const c = r.checks.find((x) => x.name === "company");
    expect(c?.ok).toBe(false);
    expect(c?.detail).toContain("NO companies");
  });

  test("the check is listed before control-version, which fails for the same cause with less to say", async () => {
    const r = await runDoctor(cfgFixture(), {
      ...live,
      companies: async () => ({ configured: "X", names: ["Y"] }),
    });
    const names = r.checks.map((c) => c.name);
    expect(names.indexOf("company")).toBeLessThan(names.indexOf("control-version"));
  });

  test("an absent dep means no check, not a vacuous pass", async () => {
    const r = await runDoctor(cfgFixture(), live);
    expect(r.checks.some((c) => c.name === "company")).toBe(false);
  });
});
