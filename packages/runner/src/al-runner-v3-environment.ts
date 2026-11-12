/**
 * R938: which server environment al-runner v3 is told it runs in (`--environment saas|onprem`).
 *
 * Order, first answer wins: `alRunnerV3.environment`, then the target's `.vscode/launch.json`
 * (`configurations[].environmentType`: OnPrem -> onprem, Sandbox or Production -> saas), else
 * nothing answered. This file reads `environmentType` and nothing else from launch.json: that file
 * can hold server URLs and auth settings.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type V3Environment = "saas" | "onprem";
export type V3EnvironmentSource = "config" | "launch.json" | "unstated";

export interface V3EnvironmentChoice {
  /** `undefined`: nothing answered, so no flag is passed (al-runner's default, `saas`). */
  readonly value: V3Environment | undefined;
  readonly source: V3EnvironmentSource;
  /** Why launch.json did not answer, when it was read and disagreed or held no usable value. */
  readonly note?: string;
}

export interface LaunchEnvironment {
  readonly value?: V3Environment;
  readonly note?: string;
}

/** Reads `<projectDir>/.vscode/launch.json`. A missing file is no answer; an unreadable one says so. */
export async function readLaunchEnvironment(
  projectDir: string,
  read: (p: string) => Promise<string> = (p) => readFile(p, "utf8"),
): Promise<LaunchEnvironment> {
  let text: string;
  try {
    text = await read(join(projectDir, ".vscode", "launch.json"));
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = Bun.JSONC.parse(text); // launch.json allows comments and trailing commas
  } catch {
    return { note: "the target's .vscode/launch.json could not be parsed" };
  }
  const configs = (parsed as { configurations?: unknown } | null)?.configurations;
  if (!Array.isArray(configs)) return {};
  const seen = new Set<V3Environment>();
  for (const c of configs) {
    const t = (c as { environmentType?: unknown } | null)?.environmentType;
    if (t === "OnPrem") seen.add("onprem");
    else if (t === "Sandbox" || t === "Production") seen.add("saas");
  }
  if (seen.size === 1) return { value: [...seen][0] as V3Environment };
  if (seen.size > 1) {
    return {
      note: "the configurations in the target's .vscode/launch.json disagree on environmentType (OnPrem and Sandbox/Production)",
    };
  }
  return {};
}

/** R938 (owner's ruling A): nothing answered, so the run stops by name before any compile. */
export class V3EnvironmentUnknownError extends Error {
  constructor(note?: string) {
    super(
      `al-runner-v3: the target's environment is unknown (no alRunnerV3.environment in the config, no environmentType in the target's .vscode/launch.json)${
        note !== undefined ? ` (${note})` : ""
      }; set alRunnerV3.environment to "onprem" or "saas"`,
    );
    this.name = "V3EnvironmentUnknownError";
  }
}

/**
 * THE decision (R938): config, then launch.json; when neither answers, refuse by name (owner's
 * ruling A, "unknown is not no"). The "unstated" source stays a type for older stored reports.
 */
export function resolveV3Environment(a: {
  readonly config?: V3Environment | undefined;
  readonly launch: LaunchEnvironment;
}): V3EnvironmentChoice {
  if (a.config !== undefined) return { value: a.config, source: "config" };
  if (a.launch.value !== undefined) return { value: a.launch.value, source: "launch.json" };
  throw new V3EnvironmentUnknownError(a.launch.note);
}

/** The config key wins, and then launch.json is not even read. */
export async function chooseV3Environment(
  projectDir: string,
  config: V3Environment | undefined,
  read?: (p: string) => Promise<string>,
): Promise<V3EnvironmentChoice> {
  return resolveV3Environment({
    config,
    launch: config !== undefined ? {} : await readLaunchEnvironment(projectDir, read),
  });
}

/** The one line the run header (stderr) prints. */
export function describeV3Environment(c: V3EnvironmentChoice): string {
  const base =
    c.value !== undefined
      ? `al-runner-v3: environment: ${c.value} (${c.source === "config" ? "alRunnerV3.environment" : "the target's .vscode/launch.json"})`
      : "al-runner-v3: environment: not stated (no alRunnerV3.environment, no launch.json environmentType); al-runner's default `saas` applies, and tests that expect an on-prem server may fail at baseline (R938)";
  return c.note !== undefined ? `${base}; ${c.note}` : base;
}
