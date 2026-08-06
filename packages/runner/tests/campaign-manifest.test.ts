import { beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  rmdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { defaultRecordsDir } from "../src/campaign-freeze";
import {
  CampaignManifestError,
  findRepoRoot,
  readCampaignManifest,
  resolveRecordsDir,
} from "../src/campaign-manifest";

function fixturePath(name: string): string {
  return join(import.meta.dir, "fixtures", name);
}

describe("readCampaignManifest — reading a campaign's own manifest", () => {
  // The fixture's recordsDir ("docs/campaign/9999-99-99-fixture-only") is deliberately NOT the
  // real campaign's own recordsDir ("docs/campaign/2026-08-03-do", campaign-freeze.ts's
  // THIS_CAMPAIGN_MANIFEST). Fix round 1: the fixture originally reused the real value, so a
  // mutant that made readCampaignManifest ignore the parsed JSON's recordsDir field and just
  // return THIS_CAMPAIGN_MANIFEST's own value passed this test anyway — coincidence read as
  // coverage. A fixture value that cannot coincide with any production default is the only way
  // this assertion proves the field was actually read OFF THE FILE.
  test("a manifest names its records directory", () => {
    const m = readCampaignManifest(fixturePath("campaign.json"));
    expect(m.recordsDir).toBe("docs/campaign/9999-99-99-fixture-only");
  });

  // The fixture's campaignId ("fixture-campaign-42") is distinctive precisely so this assertion
  // cannot pass by accident: a broken implementation that returns the WRONG field, an empty
  // string, or a plausible-looking placeholder would not coincidentally produce this exact value.
  test("a manifest names its campaignId, distinctly from any plausible default", () => {
    const m = readCampaignManifest(fixturePath("campaign.json"));
    expect(m.campaignId).toBe("fixture-campaign-42");
  });

  test("a manifest missing recordsDir throws, naming the field and the file", () => {
    expect(() => readCampaignManifest(fixturePath("campaign-missing.json"))).toThrow(/recordsDir/);
    try {
      readCampaignManifest(fixturePath("campaign-missing.json"));
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CampaignManifestError);
      // "naming ... the file" — not just the field.
      expect(String((err as Error).message)).toContain("campaign-missing.json");
    }
  });
});

describe("readCampaignManifest — caller-contract violations, fail loud not empty", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lethal-campaign-manifest-"));
  });

  test("a manifest missing campaignId throws, naming the field and the file", () => {
    const p = join(dir, "no-campaign-id.json");
    writeFileSync(p, JSON.stringify({ recordsDir: "docs/campaign/x" }), "utf8");
    expect(() => readCampaignManifest(p)).toThrow(/campaignId/);
    try {
      readCampaignManifest(p);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(CampaignManifestError);
      expect(String((err as Error).message)).toContain("no-campaign-id.json");
    }
  });

  test("an empty string recordsDir is refused, not silently resolved to the repo root", () => {
    const p = join(dir, "empty-records-dir.json");
    writeFileSync(p, JSON.stringify({ recordsDir: "", campaignId: "x" }), "utf8");
    expect(() => readCampaignManifest(p)).toThrow(/recordsDir/);
  });

  // Fix round 1, Minor: "   " is not the empty string, so a plain `.length === 0` check let it
  // straight through — refused now via `.trim().length === 0`, same as the empty-string case one
  // line above.
  test("a whitespace-only recordsDir is refused, not treated as a real directory name", () => {
    const p = join(dir, "whitespace-records-dir.json");
    writeFileSync(p, JSON.stringify({ recordsDir: "   ", campaignId: "x" }), "utf8");
    expect(() => readCampaignManifest(p)).toThrow(/recordsDir/);
  });

  test("a whitespace-only campaignId is refused too, for the same reason", () => {
    const p = join(dir, "whitespace-campaign-id.json");
    writeFileSync(
      p,
      JSON.stringify({ recordsDir: "docs/campaign/x", campaignId: "  \t " }),
      "utf8",
    );
    expect(() => readCampaignManifest(p)).toThrow(/campaignId/);
  });

  test("a manifest that is a JSON array, not an object, is refused", () => {
    const p = join(dir, "array.json");
    writeFileSync(p, JSON.stringify(["not", "an", "object"]), "utf8");
    expect(() => readCampaignManifest(p)).toThrow(CampaignManifestError);
  });

  test("invalid JSON is refused as a CampaignManifestError, not a bare SyntaxError", () => {
    const p = join(dir, "malformed.json");
    writeFileSync(p, "{ this is not json", "utf8");
    expect(() => readCampaignManifest(p)).toThrow(CampaignManifestError);
  });

  test("a nonexistent path is refused, naming the path", () => {
    const p = join(dir, "does-not-exist.json");
    expect(() => readCampaignManifest(p)).toThrow(/does-not-exist\.json/);
  });
});

describe("resolveRecordsDir — resolved against the repo root, never process.cwd()", () => {
  test("the records dir resolves to an absolute path", () => {
    // campaign-freeze.ts already walks up to `.git` for exactly this reason — a cwd-relative
    // path silently creates a records tree somewhere else and reports success. The brief's own
    // test pinned a Windows drive-letter regex (`/^[A-Za-z]:/`), which would fail on POSIX CI;
    // `isAbsolute()` is the platform-neutral form of the same property.
    const resolved = resolveRecordsDir({ recordsDir: "docs/campaign/x", campaignId: "x" });
    expect(isAbsolute(resolved)).toBe(true);
  });

  test("the resolved path ends with the manifest's own recordsDir, not some other value", () => {
    // Distinctive recordsDir so this cannot pass against a resolver that ignores its argument
    // and always returns some other hardcoded path.
    const resolved = resolveRecordsDir({
      recordsDir: "docs/campaign/distinctive-fixture-dir",
      campaignId: "x",
    });
    expect(resolved.replace(/\\/g, "/")).toMatch(/docs\/campaign\/distinctive-fixture-dir$/);
  });

  test("two different manifests resolve to two different directories", () => {
    const a = resolveRecordsDir({ recordsDir: "docs/campaign/a", campaignId: "x" });
    const b = resolveRecordsDir({ recordsDir: "docs/campaign/b", campaignId: "x" });
    expect(a).not.toBe(b);
  });

  test("findRepoRoot locates THIS worktree's root, where .git is a FILE, not a directory", () => {
    // The worktree-vs-checkout distinction campaign-freeze.ts's original doc comment called out:
    // `.git` here is a file pointing at `.git/worktrees/<name>`, and existsSync must not care.
    const root = findRepoRoot(import.meta.dir);
    const gitPath = join(root, ".git");
    expect(existsSync(gitPath)).toBe(true);
    expect(statSync(gitPath).isFile()).toBe(true);
  });

  test("resolveRecordsDir composes findRepoRoot with the manifest's recordsDir exactly", () => {
    const manifest = { recordsDir: "docs/campaign/compose-check", campaignId: "x" };
    const resolved = resolveRecordsDir(manifest);
    expect(resolved).toBe(join(findRepoRoot(import.meta.dir), manifest.recordsDir));
  });
});

describe("resolveRecordsDir — traversal escape refused (fix round 1, Important 1)", () => {
  // Reviewer's exact reproduction: `join()` collapses `..` segments rather than refusing them,
  // so enough of them walk the resolved path OUTSIDE the repository root entirely — silently,
  // and until this fix nothing checked for it.
  test("enough ../ segments to leave the repository root are refused, not silently resolved", () => {
    expect(() =>
      resolveRecordsDir({ recordsDir: "../../../../etc/evil", campaignId: "x" }),
    ).toThrow(CampaignManifestError);
    expect(() =>
      resolveRecordsDir({ recordsDir: "../../../../etc/evil", campaignId: "x" }),
    ).toThrow(/not inside the repository root/);
  });

  // A recordsDir that resolves to the repo root itself (e.g. an empty string reaching
  // resolveRecordsDir directly, bypassing readCampaignManifest's own validation) is the same
  // failure as the traversal case, one step short of it — also refused.
  test("a recordsDir that resolves to exactly the repository root is refused", () => {
    expect(() => resolveRecordsDir({ recordsDir: "", campaignId: "x" })).toThrow(
      CampaignManifestError,
    );
  });

  // Containment, not string-matching: a `..` that stays INSIDE the repo must not be refused —
  // proves the fix checks the resolved RESULT, not the literal substring ".." in the input (which
  // the reviewer specifically warned would misses encodings/symlinks and give false confidence).
  test("an internal .. that never leaves the repository root is NOT refused", () => {
    const resolved = resolveRecordsDir({
      recordsDir: "docs/campaign/../campaign/valid",
      campaignId: "x",
    });
    expect(resolved.replace(/\\/g, "/")).toMatch(/docs\/campaign\/valid$/);
  });
});

describe("resolveRecordsDir — segment-boundary containment, not string prefix (fix round 2, Defect 2)", () => {
  // Re-reviewer's exact reproduction: `rel.startsWith("..")` (fix round 1's check) is a STRING
  // PREFIX test, so it also matched legitimate names that merely start with the two characters
  // "..". Neither of these ever climbs above the repository root — both must be ALLOWED.
  test("a recordsDir starting with .. that never leaves the repo is allowed", () => {
    const resolved = resolveRecordsDir({ recordsDir: "..foo", campaignId: "x" });
    expect(resolved.replace(/\\/g, "/")).toMatch(/\.\.foo$/);
  });

  test("a recordsDir of three dots is allowed — not a real traversal", () => {
    const resolved = resolveRecordsDir({ recordsDir: "...", campaignId: "x" });
    expect(resolved.replace(/\\/g, "/")).toMatch(/\.\.\.$/);
  });

  // The other direction, in the SAME fix: a fix that only widens the allowance could let a real
  // traversal back through. Must still be refused after the segment-boundary rewrite.
  test("a real traversal is still refused after the segment-boundary fix", () => {
    expect(() => resolveRecordsDir({ recordsDir: "../evil", campaignId: "x" })).toThrow(
      CampaignManifestError,
    );
  });

  test("docs/campaign/../../.. (climbs exactly to above the repo) is still refused", () => {
    expect(() =>
      resolveRecordsDir({ recordsDir: "docs/campaign/../../..", campaignId: "x" }),
    ).toThrow(CampaignManifestError);
  });
});

describe("resolveRecordsDir — symlink/junction bypass refused (fix round 2, Defect 1)", () => {
  // Re-reviewer's exact class of reproduction: path.join/path.relative are purely lexical and
  // never touch the filesystem, so an EXISTING junction inside the repo that redirects outside
  // sails through the lexical containment check untouched. A Windows junction needs no elevated
  // privileges to create. The junction and its (scratch, newly-created) target are both cleaned
  // up in `finally` regardless of pass/fail — nothing is left behind on disk.
  test("an existing junction inside the repo that redirects outside is refused, not silently followed", () => {
    const root = findRepoRoot(import.meta.dir);
    const outside = mkdtempSync(join(tmpdir(), "lethal-outside-repo-"));
    const linkPath = join(root, "docs", "campaign", "__test_junction__");
    if (existsSync(linkPath)) {
      rmdirSync(linkPath); // clear a stale leftover from a previously aborted run
    }
    symlinkSync(outside, linkPath, "junction");
    try {
      expect(() =>
        resolveRecordsDir({
          recordsDir: "docs/campaign/__test_junction__/leaked",
          campaignId: "x",
        }),
      ).toThrow(CampaignManifestError);
      expect(() =>
        resolveRecordsDir({
          recordsDir: "docs/campaign/__test_junction__/leaked",
          campaignId: "x",
        }),
      ).toThrow(/real path/);
    } finally {
      rmdirSync(linkPath); // removes the junction stub itself, NOT the target's contents
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("campaign-freeze.ts's defaultRecordsDir — now a caller of the shared mechanism", () => {
  test("defaultRecordsDir delegates to resolveRecordsDir for this campaign's own manifest", () => {
    // Locks in that campaign-freeze.ts's zero-arg default is no longer an independently
    // hardcoded join — it is provably the SAME value resolveRecordsDir computes for this
    // campaign's own (recordsDir, campaignId) pair, via the identical shared function.
    expect(defaultRecordsDir()).toBe(
      resolveRecordsDir({ recordsDir: "docs/campaign/2026-08-03-do", campaignId: "2026-08-03-do" }),
    );
  });

  test("defaultRecordsDir still ends in this campaign's own directory name", () => {
    expect(defaultRecordsDir().replace(/\\/g, "/")).toMatch(/docs\/campaign\/2026-08-03-do$/);
  });
});
