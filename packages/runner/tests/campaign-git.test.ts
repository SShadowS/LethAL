import { describe, expect, test } from "bun:test";
import { UncommittedPathError, assertCommitted } from "../src/campaign-git";

describe("assertCommitted — 'committed BEFORE the run', made mechanical", () => {
  test("a clean, tracked file passes", async () => {
    await expect(
      assertCommitted(["docs/campaign/x/rung1.precommit.md"], { status: async () => "" }),
    ).resolves.toBeUndefined();
  });

  test("a MODIFIED file is refused, naming it", async () => {
    await expect(
      assertCommitted(["docs/campaign/x/rung1.precommit.md"], {
        status: async () => " M docs/campaign/x/rung1.precommit.md",
      }),
    ).rejects.toThrow(/rung1\.precommit\.md/);
  });

  test("an UNTRACKED file is refused — the commonest way to skip the discipline", async () => {
    await expect(
      assertCommitted(["docs/campaign/x/rung1.precommit.md"], {
        status: async () => "?? docs/campaign/x/rung1.precommit.md",
      }),
    ).rejects.toThrow(/untracked|not committed/i);
  });

  test("the refusal explains WHY, not just what", async () => {
    try {
      await assertCommitted(["p.md"], { status: async () => "?? p.md" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(String((err as Error).message)).toMatch(/before the run|after seeing/i);
    }
  });
});

describe("assertCommitted — fail-closed boundary and multi-path behaviour", () => {
  test("a status this module never enumerated is STILL refused (fail closed, not a code list)", async () => {
    // "UU" is a merge-conflict code — not untracked, not the plain " M"/"??" the four tests above
    // exercise. Nothing in campaign-git.ts special-cases it; it refuses because it is not the
    // empty string, which is the whole point of deciding dirtiness that way.
    await expect(
      assertCommitted(["docs/campaign/x/rung1.precommit.md"], {
        status: async () => "UU docs/campaign/x/rung1.precommit.md",
      }),
    ).rejects.toThrow(UncommittedPathError);
  });

  test("a rename status is refused too, and still names the path and the reason", async () => {
    await expect(
      assertCommitted(["docs/campaign/x/rung1.precommit.md"], {
        status: async () => "R  docs/campaign/x/old.md -> docs/campaign/x/rung1.precommit.md",
      }),
    ).rejects.toThrow(/rung1\.precommit\.md/);
  });

  test("whitespace-only status (e.g. a trailing newline from a real subprocess) still counts as clean", async () => {
    await expect(
      assertCommitted(["docs/campaign/x/rung1.precommit.md"], { status: async () => "\n" }),
    ).resolves.toBeUndefined();
  });

  test("with several paths, only the dirty ones are named — the clean ones are silent", async () => {
    const statuses: Record<string, string> = {
      "a.md": "",
      "b.md": " M b.md",
      "c.md": "?? c.md",
    };
    try {
      await assertCommitted(["a.md", "b.md", "c.md"], {
        status: async (p) => statuses[p] ?? "",
      });
      throw new Error("should have thrown");
    } catch (err) {
      const message = String((err as Error).message);
      expect(message).not.toMatch(/"a\.md"/);
      expect(message).toMatch(/"b\.md"/);
      expect(message).toMatch(/"c\.md"/);
      expect((err as UncommittedPathError).paths).toEqual(["b.md", "c.md"]);
    }
  });

  test("status is called once per path, with that exact path", async () => {
    const calls: string[] = [];
    await assertCommitted(["a.md", "b.md"], {
      status: async (p) => {
        calls.push(p);
        return "";
      },
    });
    expect(calls).toEqual(["a.md", "b.md"]);
  });
});
