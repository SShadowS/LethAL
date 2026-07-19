import { describe, expect, it } from "bun:test";
import {
  VersionOverflowError,
  nextAbove,
  parseVersionConflict,
  reserveAppVersion,
} from "../src/app-version";

// 2026-07-19T00:00:00Z = 20653 days since epoch.
const T0 = Date.UTC(2026, 6, 19, 0, 0, 0);

describe("reserveAppVersion", () => {
  it("takes major.minor from the source version and clock for build.revision", () => {
    // 01:00:00 => 3600s => 1800 half-seconds
    const v = reserveAppVersion({ sourceVersion: "2.3.0.0", nowMs: T0 + 3_600_000 });
    expect(v).toBe("2.3.20653.1800");
  });

  it("never forces a 2.x project under a 1.0 ceiling", () => {
    const v = reserveAppVersion({ sourceVersion: "2.0.0.0", nowMs: T0 });
    expect(v.startsWith("2.0.")).toBe(true);
  });

  it("is strictly increasing even when the clock does not advance", () => {
    const a = reserveAppVersion({ sourceVersion: "1.0.0.0", nowMs: T0 });
    const b = reserveAppVersion({ sourceVersion: "1.0.0.0", nowMs: T0, lastIssued: a });
    const c = reserveAppVersion({ sourceVersion: "1.0.0.0", nowMs: T0, lastIssued: b });
    expect(b).toBe("1.0.20653.1");
    expect(c).toBe("1.0.20653.2");
  });

  it("is strictly increasing when the clock steps backwards", () => {
    // a is stamped at 01:00:00 => 1.0.20653.1800. b is stamped an hour EARLIER, so its
    // clock-derived candidate (1.0.20653.0) sorts below a and must be overridden.
    const a = reserveAppVersion({ sourceVersion: "1.0.0.0", nowMs: T0 + 3_600_000 });
    const b = reserveAppVersion({ sourceVersion: "1.0.0.0", nowMs: T0, lastIssued: a });
    expect(a).toBe("1.0.20653.1800");
    expect(b).toBe("1.0.20653.1801");
  });

  it("rejects a malformed source version rather than guessing", () => {
    expect(() => reserveAppVersion({ sourceVersion: "1.0", nowMs: T0 })).toThrow(/four-part/);
  });

  it("fails loudly on revision overflow instead of wrapping", () => {
    expect(() =>
      reserveAppVersion({
        sourceVersion: "65535.65535.0.0",
        nowMs: T0,
        lastIssued: "65535.65535.65535.65535",
      }),
    ).toThrow(VersionOverflowError);
  });
});

describe("parseVersionConflict", () => {
  it("extracts the installed version BC names in its rejection", () => {
    const msg =
      "The request for path /BC/dev/apps failed with code UnprocessableEntity. Reason: " +
      "Cannot install the extension LethAL Sandbox App by LethAL 1.0.0.999 because a newer " +
      "version 1.0.106.0 was already installed.";
    expect(parseVersionConflict(msg)).toBe("1.0.106.0");
  });

  it("returns null for an unrelated publish failure", () => {
    expect(parseVersionConflict("Publish failed: connection refused")).toBeNull();
  });
});

describe("nextAbove", () => {
  it("increments the revision", () => {
    expect(nextAbove("1.0.106.0")).toBe("1.0.106.1");
  });

  it("carries into build when the revision is saturated", () => {
    expect(nextAbove("1.0.106.65535")).toBe("1.0.107.0");
  });

  it("throws rather than wrapping when no successor exists", () => {
    expect(() => nextAbove("65535.65535.65535.65535")).toThrow(VersionOverflowError);
  });
});
