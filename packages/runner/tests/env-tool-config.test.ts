import { describe, expect, it } from "bun:test";
import { validateEnvToolConfig } from "../src/env-tool";
import type { EnvToolConfigSection, EnvToolReadyBlock } from "../src/env-tool";

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
});
