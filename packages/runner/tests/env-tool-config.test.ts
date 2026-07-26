import { describe, expect, it } from "bun:test";
import { validateEnvToolConfig } from "../src/env-tool";
import type { EnvToolBlock, EnvToolConfigSection, EnvToolReadyBlock } from "../src/env-tool";

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

const opts = { env: ENV, hasPackageCachePath: true };

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
    const cfg = base({
      vars: { a: "1", b: "{a}" },
      publish: { command: ["publish", "{a}", "{b}", "{appFile}"] },
    });
    expect(() => validateEnvToolConfig(cfg, opts)).toThrow(/\ba\b/);
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
    expect(() => validateEnvToolConfig(base(), { env: ENV, hasPackageCachePath: false })).toThrow(
      /downloadSymbols/,
    );
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
    });
    expect(out.readyWhen?.equals).toBe("Running");
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

  it("does not throw when bcdevDeclaredKeys is omitted (opt-in check, no false positives for callers that don't pass it)", () => {
    const cfg = base();
    expect(() => validateEnvToolConfig(cfg, opts)).not.toThrow();
  });
});
