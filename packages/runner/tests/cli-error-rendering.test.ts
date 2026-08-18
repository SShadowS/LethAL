import { describe, expect, test } from "bun:test";
import { join } from "node:path";

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

async function runCli(
  args: readonly string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const stderr = await new Response(proc.stderr).text();
  return { code: await proc.exited, stderr };
}

describe("how the CLI renders a refusal", () => {
  test("a missing config is a named refusal, not a stack trace", async () => {
    const { code, stderr } = await runCli(["doctor", "--config", "definitely-not-here.json"]);
    expect(code).toBe(1);
    expect(stderr).toContain("definitely-not-here.json");
    // The specific regression: `at loadLethalConfigFile (...)` frames in a user's face.
    expect(stderr).not.toMatch(/^\s+at /m);
  });

  test("a usage mistake is a named refusal too", async () => {
    const { code, stderr } = await runCli(["run", "--project", "p", "--backend", "bcdev"]);
    expect(code).toBe(1);
    expect(stderr).toContain("--tests");
    expect(stderr).not.toMatch(/^\s+at /m);
  });

  test("it SAYS where the detail went, rather than just withholding it", async () => {
    // An unexplained absence of detail is its own problem when someone is filing a bug.
    const { stderr } = await runCli(["doctor", "--config", "nope.json"]);
    expect(stderr).toContain("LETHAL_DEBUG=1");
  });

  test("LETHAL_DEBUG=1 restores the full stack", async () => {
    const { code, stderr } = await runCli(["doctor", "--config", "nope.json"], {
      LETHAL_DEBUG: "1",
    });
    expect(code).toBe(1);
    expect(stderr).toMatch(/^\s+at /m);
  });

  test("an unknown subcommand still names every valid one", async () => {
    // The refusal that a first-time typo actually hits; it must keep carrying the list.
    const { stderr } = await runCli(["explian", "report.json"]);
    expect(stderr).toContain("expected one of:");
    expect(stderr).toContain("init");
    expect(stderr).not.toMatch(/^\s+at /m);
  });
});
