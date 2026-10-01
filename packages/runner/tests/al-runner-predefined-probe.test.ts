import { describe, expect, spyOn, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { AlRunnerBackend } from "../src/al-runner-backend";
import {
  AL_RUNNER_PREDEFINED_CANDIDATES,
  AL_RUNNER_PREDEFINED_PROBE_TEST,
  AlRunnerPredefinedProbeError,
  predefinedSymbolsChangedWarning,
  probeAlRunnerPredefinedSymbols,
} from "../src/al-runner-predefined-probe";
import { OneShotTransport } from "../src/al-runner-transport";
import { AL_RUNNER_PREDEFINED_SYMBOLS_V2_12_0 } from "../src/preprocessor-symbols";
import {
  probeFailed as failed,
  fakeProbeSpawn as fakeSpawn,
  maskFor,
} from "./helpers/al-runner-predefined";

const V2_12 = new Set(AL_RUNNER_PREDEFINED_SYMBOLS_V2_12_0);

async function refusal(
  tests: Parameters<typeof fakeSpawn>[0],
): Promise<AlRunnerPredefinedProbeError> {
  const { spawn } = fakeSpawn(tests);
  try {
    await probeAlRunnerPredefinedSymbols("al-runner", { spawn });
  } catch (err) {
    if (err instanceof AlRunnerPredefinedProbeError) return err;
    throw err;
  }
  throw new Error("the probe accepted an answer it must refuse");
}

describe("probeAlRunnerPredefinedSymbols (R392)", () => {
  test("measures 41 candidates, CLEANSCHEMA1..40 and CLEANSCHEMA", () => {
    expect(AL_RUNNER_PREDEFINED_CANDIDATES).toHaveLength(41);
    expect(AL_RUNNER_PREDEFINED_CANDIDATES).toContain("CLEANSCHEMA40");
    expect(AL_RUNNER_PREDEFINED_CANDIDATES).toContain("CLEANSCHEMA");
  });

  test("a complete mask is read as the + candidates; one one-shot spawn, no --define", async () => {
    const { calls, spawn } = fakeSpawn(failed(maskFor(V2_12)));
    const probe = await probeAlRunnerPredefinedSymbols("al-runner", { spawn });
    expect([...probe.symbols]).toEqual([...AL_RUNNER_PREDEFINED_SYMBOLS_V2_12_0].sort());
    expect(calls).toHaveLength(1);
    const argv = calls[0] ?? [];
    expect(argv).not.toContain("--define");
    expect(argv).not.toContain("--server");
    expect(argv[argv.indexOf("--test") + 1]).toBe(AL_RUNNER_PREDEFINED_PROBE_TEST);
  });

  test("the scratch project is removed afterwards", async () => {
    const before = (await readdir(tmpdir())).filter((d) => d.startsWith("lethal-r392-probe-"));
    await probeAlRunnerPredefinedSymbols("al-runner", fakeSpawn(failed(maskFor(V2_12))));
    const after = (await readdir(tmpdir())).filter((d) => d.startsWith("lethal-r392-probe-"));
    expect(after.length).toBeLessThanOrEqual(before.length);
  });

  test("the session's platform-app pin reaches the probe's argv", async () => {
    const { calls, spawn } = fakeSpawn(failed(maskFor(V2_12)));
    await probeAlRunnerPredefinedSymbols("al-runner", { spawn, platformAppsDir: "C:/pin" });
    const argv = calls[0] ?? [];
    expect(argv[argv.indexOf("--package-cache") + 1]).toBe("C:/pin");
    expect(argv).not.toContain("--auto-provision");
  });

  test("a mismatch is returned as measured, with a named added/removed warning", async () => {
    const defined = new Set([...V2_12, "CLEANSCHEMA26"]);
    defined.delete("CLEANSCHEMA1");
    const probe = await probeAlRunnerPredefinedSymbols(
      "al-runner",
      fakeSpawn(failed(maskFor(defined))),
    );
    expect(probe.symbols).toContain("CLEANSCHEMA26");
    expect(probe.symbols).not.toContain("CLEANSCHEMA1");
    const w = predefinedSymbolsChangedWarning(probe);
    expect(w).toContain("added [CLEANSCHEMA26]");
    expect(w).toContain("removed [CLEANSCHEMA1]");
  });

  test("a match produces no warning", async () => {
    const probe = await probeAlRunnerPredefinedSymbols(
      "al-runner",
      fakeSpawn(failed(maskFor(V2_12))),
    );
    expect(predefinedSymbolsChangedWarning(probe)).toBeUndefined();
  });

  const full = maskFor(V2_12);
  const partials: ReadonlyArray<[string, Parameters<typeof fakeSpawn>[0], RegExp]> = [
    ["a missing candidate", failed(full.replace("-CLEANSCHEMA33 ", "")), /CLEANSCHEMA33/],
    ["a repeat", failed(maskFor(V2_12, { tail: "-CLEANSCHEMA30 " })), /more than once/],
    ["an unknown token", failed(maskFor(V2_12, { tail: "+FOO " })), /unknown/],
    ["a token with no sign", failed(maskFor(V2_12, { tail: "CLEANSCHEMA30 " })), /unknown/],
    ["no ALWAYS", failed(full.replace("+ALWAYS ", "")), /ALWAYS/],
    ["NEVER present", failed(maskFor(V2_12, { tail: "+NEVER " })), /never-defined NEVER/],
    ["two masks", failed(`${full} ${full}`), /exactly one/],
    [
      "a second, unterminated mask inside the first",
      failed(`R392MASK: ${full}`),
      /unknown token "R392MASK:/,
    ],
    ["no mask", failed("BOOM"), /exactly one/],
    ["an unterminated mask", failed(full.replace(":END", "")), /exactly one/],
    ["the wrong test", failed(full, "Codeunit1.Other"), /Codeunit1\.Other/],
    [
      "a passed status, even with a complete mask",
      [{ name: AL_RUNNER_PREDEFINED_PROBE_TEST, status: "pass", message: full }],
      /reported status "pass"/,
    ],
    ["no result", [], /exactly one result/],
    [
      "two results",
      [...failed(full), { name: AL_RUNNER_PREDEFINED_PROBE_TEST, status: "fail", message: full }],
      /exactly one result/,
    ],
    ["a failed run", { exitCode: 3, stderr: "AL0118 compile error" }, /AL0118/],
  ];
  for (const [name, tests, reason] of partials) {
    test(`refuses ${name}`, async () => {
      const err = await refusal(tests);
      expect(err.message).toMatch(reason);
      expect(err.message).toContain("R392");
    });
  }

  test("AlRunnerBackend.measurePredefinedSymbols runs the probe on its own binary, spawn and pin", async () => {
    const { calls, spawn } = fakeSpawn(failed(maskFor(V2_12)));
    const backend = new AlRunnerBackend(
      {
        alRunnerPath: "C:/tools/al-runner.exe",
        instrumentedDir: "/i",
        testDir: "/t",
        selectorObjectId: 50000,
      },
      spawn,
    );
    const probe = await backend.measurePredefinedSymbols("C:/pin");
    expect(probe.symbols).toHaveLength(25);
    const argv = calls[0] ?? [];
    expect(calls).toHaveLength(1);
    expect(argv[0]).toBe("C:/tools/al-runner.exe");
    expect(argv[argv.indexOf("--package-cache") + 1]).toBe("C:/pin");
  });

  test("text before and after the mask, and CRLF line endings, are accepted (a decision)", async () => {
    const mask = maskFor(V2_12).replace(/ /g, "\r\n");
    const { spawn } = fakeSpawn(failed(`Assertion failed\r\nR392 says: ${mask} trailing text\r\n`));
    const probe = await probeAlRunnerPredefinedSymbols("al-runner", { spawn });
    expect([...probe.symbols]).toEqual([...AL_RUNNER_PREDEFINED_SYMBOLS_V2_12_0].sort());
  });

  test("the transport is closed even when send throws", async () => {
    const send = spyOn(OneShotTransport.prototype, "send").mockRejectedValue(new Error("boom"));
    const close = spyOn(OneShotTransport.prototype, "close");
    try {
      await expect(probeAlRunnerPredefinedSymbols("al-runner")).rejects.toThrow("boom");
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      send.mockRestore();
      close.mockRestore();
    }
  });

  test("a refusal carries al-runner's output tail", async () => {
    const err = await refusal(failed("BOOM-TAIL-TEXT"));
    expect(err.outputTail).toContain("BOOM-TAIL-TEXT");
  });
});
