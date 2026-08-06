import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
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
  test("a manifest names its records directory", () => {
    const m = readCampaignManifest(fixturePath("campaign.json"));
    expect(m.recordsDir).toBe("docs/campaign/2026-08-03-do");
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
