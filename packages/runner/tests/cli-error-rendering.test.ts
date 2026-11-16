import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeScratchDir } from "./helpers/scratch";

/**
 * How a REFUSAL reaches a user.
 *
 * Found in a clean-room container (`scripts/clean-room.sh`) against the published binary: the first
 * command the README tells a new user to run, pointed at a path that does not exist yet, answered
 * with four frames of `/$bunfs/root/...`. The message itself was fine — it named the file — but a
 * stack trace says "this tool broke" where the truth is "that file is not there", and the two are
 * not the same claim.
 *
 * Driven through the real CLI as a subprocess rather than by calling `main`, because the thing under
 * test IS the top-level handler.
 */
const CLI = join(import.meta.dir, "..", "src", "cli.ts");

/**
 * Every test below spawns a real `bun` subprocess through `runCli`, which passes alone in well
 * under a second but can push past Bun's 5 s default test timeout when something else is loading
 * the machine (a full `bun test` run, or a live itest at the same time). See HOOK_TIMEOUT_MS in
 * campaign-subcommands.test.ts (R335) for the measured shape of this failure.
 */
const SPAWN_TEST_TIMEOUT_MS = 60_000;

async function runCli(
  args: readonly string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stderr: string; stdout: string }> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const [stderr, stdout] = await Promise.all([
    new Response(proc.stderr).text(),
    new Response(proc.stdout).text(),
  ]);
  return { code: await proc.exited, stderr, stdout };
}

describe("how the CLI renders a refusal", () => {
  test(
    "a missing config is a named refusal, not a stack trace",
    async () => {
      const { code, stderr } = await runCli(["doctor", "--config", "definitely-not-here.json"]);
      expect(code).toBe(1);
      expect(stderr).toContain("definitely-not-here.json");
      // The specific regression: `at loadLethalConfigFile (...)` frames in a user's face.
      expect(stderr).not.toMatch(/^\s+at /m);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  test(
    "a usage mistake is a named refusal too",
    async () => {
      const { code, stderr } = await runCli(["run", "--project", "p", "--backend", "bcdev"]);
      expect(code).toBe(1);
      expect(stderr).toContain("--tests");
      expect(stderr).not.toMatch(/^\s+at /m);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  test(
    "it SAYS where the detail went, rather than just withholding it",
    async () => {
      // An unexplained absence of detail is its own problem when someone is filing a bug.
      const { stderr } = await runCli(["doctor", "--config", "nope.json"]);
      expect(stderr).toContain("LETHAL_DEBUG=1");
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  test(
    "LETHAL_DEBUG=1 restores the full stack",
    async () => {
      const { code, stderr } = await runCli(["doctor", "--config", "nope.json"], {
        LETHAL_DEBUG: "1",
      });
      expect(code).toBe(1);
      expect(stderr).toMatch(/^\s+at /m);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  test(
    "a line filter that keeps no site exits 8 through the real CLI",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "lethal-exit8-"));
      try {
        await Bun.write(
          join(root, "app", "app.json"),
          JSON.stringify({
            id: "0f2b7c5e-4d3a-4917-8a1c-3b4a8d9f1028",
            name: "Exit8",
            publisher: "LethAL",
            version: "1.0.0.0",
            idRanges: [{ from: 79000, to: 79199 }],
          }),
        );
        await Bun.write(
          join(root, "app", "Logic.Codeunit.al"),
          'codeunit 79000 "Logic"\n{\n    procedure IsOver(A: Decimal; B: Decimal): Boolean\n    begin\n        exit(A > B);\n    end;\n}\n',
        );
        await Bun.write(join(root, "tests", "T.Codeunit.al"), 'codeunit 79100 "T"\n{\n}\n');
        const args = [
          "run",
          "--dry-run",
          "--project",
          join(root, "app"),
          "--tests",
          join(root, "tests"),
          "--backend",
          "bcdev",
          "--lines",
          ["Logic.Codeunit.al", "1"].join(":"), // not written as a citation: line-citations.test.ts
        ];
        const plain = await runCli(args);
        expect(plain.code).toBe(8);
        expect(plain.stderr).toContain("kept no deployable mutation site");
        // `run` refuses --json, so the envelope code is covered by line-filter.test.ts (cliError).
      } finally {
        removeScratchDir(root);
      }
    },
    SPAWN_TEST_TIMEOUT_MS,
  );

  test(
    "an unknown subcommand still names every valid one",
    async () => {
      // The refusal that a first-time typo actually hits; it must keep carrying the list.
      const { stderr } = await runCli(["explian", "report.json"]);
      expect(stderr).toContain("expected one of:");
      expect(stderr).toContain("init");
      expect(stderr).not.toMatch(/^\s+at /m);
    },
    SPAWN_TEST_TIMEOUT_MS,
  );
});
