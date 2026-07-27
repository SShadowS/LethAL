import { describe, expect, it } from "bun:test";
import { validateEnvToolConfig } from "../src/env-tool";
import type {
  EnvToolBlock,
  EnvToolConfigSection,
  EnvToolReadyBlock,
  EnvToolStatusExpectation,
} from "../src/env-tool";

const ENV = { CONTINIA_ENV_ID: "env-4711", TOKEN: "s3cret" };

function base(over: Partial<EnvToolConfigSection> = {}): Partial<EnvToolConfigSection> {
  return {
    toolPath: "C:/tools/continia.exe",
    envId: "env-4711",
    resolve: [
      { command: ["env", "get", "{envId}", "--json"], reads: { baseUrl: "url" } },
      {
        command: ["env", "users", "{envId}", "--json"],
        reads: { username: "0.username", password: "0.password" },
      },
    ],
    publish: { command: ["publish", "{envId}", "{appFile}", "--json"] },
    ...over,
  };
}

// `envId: undefined` cannot be assigned under exactOptionalPropertyTypes — a JSON config that
// omits envId never has the key at all. This drops the key entirely to express "create-mode"
// (no envId) instead of the ambiguous "envId present but undefined".
function withoutEnvId(cfg: Partial<EnvToolConfigSection>): Partial<EnvToolConfigSection> {
  const { envId: _envId, ...rest } = cfg;
  return rest;
}

const opts = { env: ENV, hasPackageCachePath: true, bcdevDeclaredKeys: [] };

describe("validateEnvToolConfig", () => {
  it("accepts a reuse-mode config and substitutes ${VAR}", () => {
    const out = validateEnvToolConfig(
      base({ envId: "${CONTINIA_ENV_ID}", env: { CONTINIA_API_TOKEN: "${TOKEN}" } }),
      opts,
    );
    expect(out.envId).toBe("env-4711");
    expect(out.env?.CONTINIA_API_TOKEN).toBe("s3cret");
  });

  it("throws naming the variable and the field when ${VAR} is unset", () => {
    expect(() => validateEnvToolConfig(base({ envId: "${NOPE}" }), opts)).toThrow(
      /NOPE.*envId|envId.*NOPE/,
    );
  });

  it("rejects an unknown reads key", () => {
    const cfg = base({ resolve: [{ command: ["x"], reads: { baseUrl: "url", nope: "a" } }] });
    expect(() => validateEnvToolConfig(cfg, opts)).toThrow(/nope/);
  });

  it("rejects the same reads key produced by two blocks", () => {
    const cfg = base({
      resolve: [
        { command: ["a"], reads: { baseUrl: "url" } },
        { command: ["b"], reads: { baseUrl: "other", username: "u", password: "p" } },
      ],
    });
    expect(() => validateEnvToolConfig(cfg, opts)).toThrow(/baseUrl/);
  });

  it("rejects an unknown {placeholder}", () => {
    const cfg = base({ publish: { command: ["publish", "{nope}"] } });
    expect(() => validateEnvToolConfig(cfg, opts)).toThrow(/nope/);
  });

  it("rejects a vars entry nothing references, across ALL declared blocks", () => {
    const cfg = base({ vars: { unused: "x" } });
    expect(() => validateEnvToolConfig(cfg, opts)).toThrow(/unused/);
  });

  it("rejects a vars key shadowing a LethAL placeholder", () => {
    const cfg = base({
      vars: { envId: "x" },
      publish: { command: ["publish", "{envId}", "{appFile}"] },
    });
    expect(() => validateEnvToolConfig(cfg, opts)).toThrow(/envId/);
  });

  it("rejects a vars value referencing another vars entry", () => {
    // R22d: the fixture's vars key used to be named "a" and the assertion was `/\ba\b/` — but
    // the thrown message's own FIXED boilerplate ("...only LethAL-supplied placeholders may
    // appear inside **a** vars value") contains a standalone "a" regardless of which key is
    // actually referenced, so the regex passed even against a message naming a DIFFERENT key.
    // Renamed to "zz" (which cannot appear in the boilerplate) and the regex now pins the exact
    // sentence naming it.
    const cfg = base({
      vars: { zz: "1", b: "{zz}" },
      publish: { command: ["publish", "{zz}", "{b}", "{appFile}"] },
    });
    expect(() => validateEnvToolConfig(cfg, opts)).toThrow(
      /envTool\.vars\.b references another vars entry \{zz\}/,
    );
  });

  it("allows a LethAL placeholder inside a vars value", () => {
    const cfg = base({
      vars: { envName: "lethal-{runId}" },
      publish: { command: ["publish", "{envName}", "{appFile}"] },
    });
    expect(validateEnvToolConfig(cfg, opts).vars?.envName).toBe("lethal-{runId}");
  });

  it("requires the whole create-mode block set, one message at a time", () => {
    // Measured 2026-07-26: `env create` yields a Draft environment with nothing listening, and
    // `env start` is async — so create-mode without startEnv/readyWhen would publish to a dead
    // endpoint after paying ~6.5 minutes for the environment.
    const step = (over: Partial<EnvToolConfigSection>) => withoutEnvId(base(over));
    const createEnv = { command: ["env", "create", "--json"], reads: { envId: "id" } };
    const deleteEnv = { command: ["env", "delete", "{envId}"] };
    const startEnv = { command: ["env", "start", "{envId}"] };
    const readyWhen = {
      command: ["env", "get", "{envId}", "--json"],
      reads: { status: "status" },
      equals: "Running",
    };
    expect(() => validateEnvToolConfig(step({}), opts)).toThrow(/createEnv/);
    expect(() => validateEnvToolConfig(step({ createEnv }), opts)).toThrow(/deleteEnv/);
    expect(() => validateEnvToolConfig(step({ createEnv, deleteEnv }), opts)).toThrow(/startEnv/);
    expect(() => validateEnvToolConfig(step({ createEnv, deleteEnv, startEnv }), opts)).toThrow(
      /readyWhen/,
    );
    expect(() =>
      validateEnvToolConfig(step({ createEnv, deleteEnv, startEnv, readyWhen }), opts),
    ).toThrow(/publishApps/);
    expect(() =>
      validateEnvToolConfig(
        step({ createEnv, deleteEnv, startEnv, readyWhen, publishApps: ["tests.app"] }),
        opts,
      ),
    ).not.toThrow();
  });

  it("requires readyWhen to read status and to declare what ready means", () => {
    const common = {
      createEnv: { command: ["env", "create", "--json"], reads: { envId: "id" } },
      deleteEnv: { command: ["env", "delete", "{envId}"] },
      startEnv: { command: ["env", "start", "{envId}"] },
      publishApps: ["tests.app"],
    };
    const noStatus = withoutEnvId(
      base({
        ...common,
        readyWhen: { command: ["env", "get", "{envId}", "--json"], equals: "Running" },
      }),
    );
    expect(() => validateEnvToolConfig(noStatus, opts)).toThrow(/status/);
    // Deliberately missing the required `equals` field, to exercise the runtime check that a
    // config author forgot it — cast past the compile-time guarantee the real config type gives.
    const incompleteReadyWhen = {
      command: ["env", "get", "{envId}", "--json"],
      reads: { status: "status" },
    } as unknown as EnvToolReadyBlock;
    const noEquals = withoutEnvId(base({ ...common, readyWhen: incompleteReadyWhen }));
    expect(() => validateEnvToolConfig(noEquals, opts)).toThrow(/equals/);
  });

  it("requires downloadSymbols when packageCachePath is absent", () => {
    expect(() =>
      validateEnvToolConfig(base(), {
        env: ENV,
        hasPackageCachePath: false,
        bcdevDeclaredKeys: [],
      }),
    ).toThrow(/downloadSymbols/);
  });

  it("requires resolve to produce baseUrl, username and password", () => {
    const cfg = base({ resolve: [{ command: ["env", "get"], reads: { baseUrl: "url" } }] });
    expect(() => validateEnvToolConfig(cfg, opts)).toThrow(/username|password/);
  });

  it("allows a block with no reads at all", () => {
    const cfg = base({ deleteEnv: { command: ["env", "delete", "{envId}"] } });
    expect(() => validateEnvToolConfig(cfg, opts)).not.toThrow();
  });

  it("substitutes ${VAR} inside readyWhen.equals", () => {
    // Item 7: zero prior coverage that ${VAR} substitution reaches `equals` specifically — every
    // other readyWhen test uses a literal.
    const cfg = withoutEnvId(
      base({
        createEnv: { command: ["env", "create", "--json"], reads: { envId: "id" } },
        deleteEnv: { command: ["env", "delete", "{envId}"] },
        startEnv: { command: ["env", "start", "{envId}"] },
        readyWhen: {
          command: ["env", "get", "{envId}", "--json"],
          reads: { status: "status" },
          equals: "${READY_STATUS}",
        },
        publishApps: ["tests.app"],
      }),
    );
    const out = validateEnvToolConfig(cfg, {
      env: { ...ENV, READY_STATUS: "Running" },
      hasPackageCachePath: true,
      bcdevDeclaredKeys: [],
    });
    expect(out.readyWhen?.equals).toBe("Running");
  });
});

// ————————————————————————————————————————————————————————————————————————
// R34: a REUSED environment that has idled to a not-ready status used to resolve fine and hand
// back a dead endpoint. `requireStatus` declares what "ready" means for THIS tool (LethAL vendors
// no status vocabulary of its own); the status value itself arrives through an ordinary
// `resolve[].reads.status` entry. Every check below fires before any process is spawned.
// ————————————————————————————————————————————————————————————————————————
describe("validateEnvToolConfig — requireStatus (R34)", () => {
  const statusResolve = [
    {
      command: ["env", "get", "{envId}", "--json"],
      reads: { baseUrl: "url", status: "status" },
    },
    {
      command: ["env", "users", "{envId}", "--json"],
      reads: { username: "0.username", password: "0.password" },
    },
  ];

  it("accepts a reuse-mode expectation backed by a resolve status read", () => {
    const out = validateEnvToolConfig(
      base({ resolve: statusResolve, requireStatus: { equals: "Running" } }),
      opts,
    );
    expect(out.requireStatus?.equals).toBe("Running");
  });

  it("rejects an expectation no resolve block feeds", () => {
    // The `base()` resolve reads baseUrl/username/password and no status — nothing produces the
    // value the expectation is about, so the check would silently have nothing to compare.
    expect(() =>
      validateEnvToolConfig(base({ requireStatus: { equals: "Running" } }), opts),
    ).toThrow(
      /envTool\.requireStatus is declared but no envTool\.resolve\[\] block reads "status"/,
    );
  });

  it("rejects an expectation fed only by readyWhen, which never runs for a reused environment", () => {
    const cfg = base({
      readyWhen: {
        command: ["env", "get", "{envId}", "--json"],
        reads: { status: "status" },
        equals: "Running",
      },
      requireStatus: { equals: "Running" },
    });
    expect(() => validateEnvToolConfig(cfg, opts)).toThrow(
      /readyWhen reads it, but that block never runs for a reused environment/,
    );
  });

  it("rejects an expectation with no equals to compare against", () => {
    // Deliberately missing the required `equals`, to exercise the runtime check that a config
    // author forgot it — cast past the compile-time guarantee the config type gives.
    const cfg = base({
      resolve: statusResolve,
      requireStatus: {} as unknown as EnvToolStatusExpectation,
    });
    expect(() => validateEnvToolConfig(cfg, opts)).toThrow(
      /envTool\.requireStatus\.equals is required/,
    );
  });

  it("rejects an expectation in create-mode, where readyWhen already owns readiness", () => {
    const cfg = withoutEnvId(
      base({
        createEnv: { command: ["env", "create", "--json"], reads: { envId: "id" } },
        deleteEnv: { command: ["env", "delete", "{envId}"] },
        startEnv: { command: ["env", "start", "{envId}"] },
        readyWhen: {
          command: ["env", "get", "{envId}", "--json"],
          reads: { status: "status" },
          equals: "Running",
        },
        publishApps: ["tests.app"],
        requireStatus: { equals: "Running" },
      }),
    );
    expect(() => validateEnvToolConfig(cfg, opts)).toThrow(
      /envTool\.requireStatus applies only to a REUSED environment/,
    );
  });

  it("substitutes ${VAR} inside requireStatus.equals", () => {
    // The whole point of Layer 6C: the ready value is the TOOL's word, never LethAL's, so it must
    // be as configurable as any other value — including from the environment.
    const out = validateEnvToolConfig(
      base({ resolve: statusResolve, requireStatus: { equals: "${READY_STATUS}" } }),
      { ...opts, env: { ...ENV, READY_STATUS: "Active" } },
    );
    expect(out.requireStatus?.equals).toBe("Active");
  });

  it("names the field when requireStatus.equals is not a string", () => {
    const cfg = base({
      resolve: statusResolve,
      requireStatus: { equals: 5 } as unknown as EnvToolStatusExpectation,
    });
    expect(() => validateEnvToolConfig(cfg, opts)).toThrow(
      /envTool\.requireStatus\.equals must be a string \(got number\)/,
    );
  });

  it("leaves a config that declares no expectation exactly as it was (backward compatibility)", () => {
    // Every config written before R34 — the fixtures, docs/do-trial-runbook.md's real one — has no
    // requireStatus and no status read. It must validate unchanged, and carry no expectation
    // forward for the session to act on.
    const out = validateEnvToolConfig(base(), opts);
    expect(out.requireStatus).toBeUndefined();
    // A status read WITHOUT an expectation is also still legal — reading a value is not a demand.
    expect(validateEnvToolConfig(base({ resolve: statusResolve }), opts).requireStatus).toBe(
      undefined,
    );
  });
});

// ————————————————————————————————————————————————————————————————————————
// Item 4 (final review): a shape pass over the RAW config text, before substitution. Measured
// against the real function: each of these previously either crashed with a raw, unattributed
// `TypeError` deep inside `substituteSection`/`renderCommand`, or (the `reads` row) didn't throw
// at validation time AT ALL — it silently reached `EnvToolClient.run`'s `readPath` at spawn time.
// ————————————————————————————————————————————————————————————————————————
describe("validateEnvToolConfig — shape pass (item 4)", () => {
  it("names the field when a block is missing its command array", () => {
    const cfg = base({ publish: {} as unknown as EnvToolBlock });
    expect(() => validateEnvToolConfig(cfg, opts)).toThrow(
      /envTool\.publish\.command must be an array of strings/,
    );
  });

  it("names the field when a block's command is a string instead of an array", () => {
    const cfg = base({
      publish: { command: "publish {appFile}" } as unknown as EnvToolBlock,
    });
    expect(() => validateEnvToolConfig(cfg, opts)).toThrow(
      /envTool\.publish\.command must be an array of strings/,
    );
  });

  it("names the field when resolve is an object instead of an array", () => {
    const cfg = base({
      resolve: { command: ["env", "get"] } as unknown as readonly EnvToolBlock[],
    });
    expect(() => validateEnvToolConfig(cfg, opts)).toThrow(/envTool\.resolve must be an array/);
  });

  it("names the field when a vars value is not a string", () => {
    const cfg = base({ vars: { n: 5 } as unknown as Record<string, string> });
    expect(() => validateEnvToolConfig(cfg, opts)).toThrow(/envTool\.vars\.n must be a string/);
  });

  it("names the field when a reads value is not a string (previously did not throw at all)", () => {
    const cfg = base({
      resolve: [
        {
          command: ["env", "get", "{envId}", "--json"],
          reads: { baseUrl: "url", serverInstance: 123 } as unknown as Record<string, string>,
        },
        {
          command: ["env", "users", "{envId}", "--json"],
          reads: { username: "0.username", password: "0.password" },
        },
      ],
    });
    expect(() => validateEnvToolConfig(cfg, opts)).toThrow(
      /envTool\.resolve\[0\]\.reads\.serverInstance must be a string/,
    );
  });
});

// ————————————————————————————————————————————————————————————————————————
// Item 6 (final review): a field env-tool resolves via some block's `reads` must not ALSO be
// hand-written in the bcdev config section — fixtures/README.md's worked example calls this "two
// sources, one value". This is deliberately a validation error, not a precedence rule.
// ————————————————————————————————————————————————————————————————————————
describe("validateEnvToolConfig — bcdev/reads collision (item 6)", () => {
  it("rejects a reads key that is ALSO hand-written in the bcdev section", () => {
    const cfg = base({
      resolve: [
        {
          command: ["env", "get", "{envId}", "--json"],
          reads: { baseUrl: "url", server: "server" },
        },
        {
          command: ["env", "users", "{envId}", "--json"],
          reads: { username: "0.username", password: "0.password" },
        },
      ],
    });
    expect(() => validateEnvToolConfig(cfg, { ...opts, bcdevDeclaredKeys: ["server"] })).toThrow(
      /"server".*bcdev config section/,
    );
  });

  it("does not throw when nothing in bcdevDeclaredKeys collides with a produced reads key", () => {
    const cfg = base();
    expect(() =>
      validateEnvToolConfig(cfg, { ...opts, bcdevDeclaredKeys: ["company", "tenant"] }),
    ).not.toThrow();
  });

  // R24: `bcdevDeclaredKeys` is now REQUIRED, not optional — a caller that omits it must fail to
  // compile rather than silently lose the collision guard. This cannot be a normal runtime
  // assertion (JS does not enforce "required" at all; omitting the field at runtime just makes
  // `opts.bcdevDeclaredKeys` `undefined`, and `bun test` never type-checks). `it.skip` means the
  // body never RUNS, but `tsc --build` still type-checks it like any other source line — so
  // `@ts-expect-error` here is itself the assertion: if the call below stops being a type error
  // (i.e. someone makes the parameter optional again), `tsc` reports an unused
  // `@ts-expect-error` directive and `bun run typecheck` fails.
  it.skip("compile-time only: omitting bcdevDeclaredKeys must fail tsc --build, never run", () => {
    // @ts-expect-error - bcdevDeclaredKeys is required (R24); a caller that omits it must not compile.
    validateEnvToolConfig(base(), { env: ENV, hasPackageCachePath: true });
  });
});

// ————————————————————————————————————————————————————————————————————————
// R23: nothing may read `username`/`password` from `envTool.publish` — see env-tool.ts's doc
// comment on the check for why (the credential-withholding rule would silently blank a real
// publish failure's detail, which is exactly what the orchestrator's version-conflict recovery
// parses BC's rejection text out of).
// ————————————————————————————————————————————————————————————————————————
describe("validateEnvToolConfig — no credentials in envTool.publish.reads (R23)", () => {
  it("rejects username read from envTool.publish", () => {
    const cfg = base({
      publish: { command: ["publish", "{envId}", "{appFile}"], reads: { username: "u" } },
    });
    expect(() => validateEnvToolConfig(cfg, opts)).toThrow(/envTool\.publish\.reads.*username/s);
  });

  it("rejects password read from envTool.publish", () => {
    const cfg = base({
      publish: { command: ["publish", "{envId}", "{appFile}"], reads: { password: "p" } },
    });
    expect(() => validateEnvToolConfig(cfg, opts)).toThrow(/envTool\.publish\.reads.*password/s);
  });

  it("still allows envTool.publish to read a non-credential key", () => {
    const cfg = base({
      publish: { command: ["publish", "{envId}", "{appFile}"], reads: { server: "server" } },
    });
    expect(() => validateEnvToolConfig(cfg, opts)).not.toThrow();
  });
});
