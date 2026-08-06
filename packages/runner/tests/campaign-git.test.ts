import { describe, expect, test } from "bun:test";
import {
  CampaignGitContractError,
  UncommittedPathError,
  assertCommitted,
} from "../src/campaign-git";
import type { AssertCommittedDeps } from "../src/campaign-git";

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

describe("assertCommitted — caller-contract violations (fix round 1)", () => {
  test("an EMPTY paths array is refused, not silently treated as a pass", async () => {
    // Reviewer's reproduction: paths.map over [] never calls deps.status, so the old code fell
    // straight through to `if (dirty.length === 0) return;` and resolved undefined — an empty
    // check mistaken for a passing one, this project's signature bug, sitting inside the module
    // whose entire purpose is closing that class of gap.
    let calls = 0;
    await expect(
      assertCommitted([], {
        status: async () => {
          calls++;
          return "?? whatever";
        },
      }),
    ).rejects.toThrow(CampaignGitContractError);
    // deps.status is still never called — the guard fires before any I/O, same as before the fix.
    expect(calls).toBe(0);
  });

  test("an empty paths array names the violation, not a path", async () => {
    await expect(assertCommitted([], { status: async () => "" })).rejects.toThrow(
      /empty paths array/i,
    );
  });

  test("a non-string status is refused as a CONTRACT violation, not a bare TypeError", async () => {
    // A real subprocess-backed `status` (a later task's wiring) can resolve something other than
    // a string far more easily than this module's own pure callers can — a crashed process, a
    // malformed pipe read, a caller that forgot `await`. `raw.trim()` on a non-string would throw
    // a bare TypeError that a caller pattern-matching on this module's error types would not catch.
    const badDeps = { status: async () => undefined } as unknown as AssertCommittedDeps;
    await expect(assertCommitted(["p.md"], badDeps)).rejects.toThrow(CampaignGitContractError);
  });

  test("a non-string status names the offending path and what it must resolve instead", async () => {
    const badDeps = { status: async () => null } as unknown as AssertCommittedDeps;
    await expect(assertCommitted(["p.md"], badDeps)).rejects.toThrow(/"p\.md"/);
  });

  test("CampaignGitContractError is not an UncommittedPathError, and vice versa — instanceof stays distinguishable", async () => {
    try {
      await assertCommitted([], { status: async () => "" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CampaignGitContractError);
      expect(err).not.toBeInstanceOf(UncommittedPathError);
    }

    try {
      await assertCommitted(["p.md"], { status: async () => "?? p.md" });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UncommittedPathError);
      expect(err).not.toBeInstanceOf(CampaignGitContractError);
    }
  });
});
