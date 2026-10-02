import {
  AL_RUNNER_PREDEFINED_CANDIDATES,
  AL_RUNNER_PREDEFINED_PROBE_TEST,
} from "../../src/al-runner-predefined-probe";
import {
  AL_RUNNER_PREDEFINED_SYMBOLS_V2_12_0,
  type AlRunnerPredefinedProbe,
} from "../../src/preprocessor-symbols";
import type { SpawnFn } from "../../src/publisher";
import { alRunnerStdout } from "./al-runner-stdout";

/** R392: what a fake al-runner backend's `measurePredefinedSymbols` answers: the v2.12.0 list,
 *  so a stub that is not about R392 keeps the build it had before the probe existed. */
export async function measuredV2_12(): Promise<AlRunnerPredefinedProbe> {
  return { symbols: [...AL_RUNNER_PREDEFINED_SYMBOLS_V2_12_0].sort() };
}

/** R392: the mask a real al-runner would put in the probe's failure message, given what it defines. */
export function maskFor(
  defined: ReadonlySet<string>,
  extra: { head?: string; tail?: string } = {},
): string {
  const tokens = [
    "+ALWAYS",
    ...AL_RUNNER_PREDEFINED_CANDIDATES.map((c) => `${defined.has(c) ? "+" : "-"}${c}`),
  ];
  return `R392MASK:${extra.head ?? ""}${tokens.join(" ")} ${extra.tail ?? ""}:END`;
}

/** One fake al-runner process answering with `tests` (JSON rows), or failing with an exit code. */
export function fakeProbeSpawn(
  tests: ReadonlyArray<Record<string, unknown>> | { exitCode: number; stderr: string },
): { calls: string[][]; spawn: SpawnFn } {
  const calls: string[][] = [];
  const spawn: SpawnFn = async (argv) => {
    calls.push([...argv]);
    if (!Array.isArray(tests)) {
      const t = tests as { exitCode: number; stderr: string };
      return { exitCode: t.exitCode, stdout: "", stderr: t.stderr };
    }
    return { exitCode: 1, stdout: alRunnerStdout({ tests }), stderr: "" };
  };
  return { calls, spawn };
}

/** The probe test failing with `message`, as al-runner reports it. */
export function probeFailed(message: string, name: string = AL_RUNNER_PREDEFINED_PROBE_TEST) {
  return [{ name, status: "fail", message }];
}
