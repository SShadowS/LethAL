import { describe, expect, it } from "bun:test";
import {
  UpgradeNotRestoredError,
  VersionOverflowError,
  compareAppVersions,
  confirmedDowngradeRefusal,
  nextAbove,
  notReinstalledApps,
  parseVersionConflict,
  reserveAppVersion,
  restoreFailed,
} from "../src/app-version";

/** R-709b, measured on bc2 (probe `scripts/r709-probe/`, body-3.txt): BC's `Message` when T2 broke
 *  two installed dependents. The list after "to do so:" is one "<name> by <publisher>" per line,
 *  the target first, and gives no versions. */
const BODY_TWO =
  "Publishing failed due to 'Extension compilation failed\nsrc/Dep.Codeunit.al(7,21): error AL0132: " +
  "'Codeunit \"R709 Target\"' does not contain a definition for 'Answer''. The original extensions " +
  "could not be restored due to Cannot install the extension R709 Probe Target by LethAL Probe 1.0.0.1 " +
  "because a newer version 1.0.0.2 was already installed..\nExtensions that were previously installed " +
  "but could not be reinstalled. These extensions should be manually reinstalled. If they are part of " +
  "your current workspace, you can use the 'Full Dependency Publishing' command to do so: \n" +
  "R709 Probe Target by LethAL Probe\nR709 Probe Dep One by LethAL Probe\nR709 Probe Dep Two by " +
  "LethAL Probe\n\n\n";
/** body-5.txt: one dependent. */
const BODY_ONE =
  "Publishing failed due to 'Extension compilation failed\nsrc/Dep.Codeunit.al(7,21): error AL0132: " +
  "'Codeunit \"R709 Solo Target\"' does not contain a definition for 'Answer''. The original " +
  "extensions could not be restored due to Cannot install the extension R709 Probe Target Solo by " +
  "LethAL Probe 1.0.0.1 because a newer version 1.0.0.2 was already installed..\nExtensions that " +
  "were previously installed but could not be reinstalled. These extensions should be manually " +
  "reinstalled. If they are part of your current workspace, you can use the 'Full Dependency " +
  "Publishing' command to do so: \nR709 Probe Target Solo by LethAL Probe\nR709 Probe Dep Solo by " +
  "LethAL Probe\n\n\n";

describe("notReinstalledApps (R709 part 2: BC's measured list)", () => {
  it("two dependents: every line after 'to do so:', the target first", () => {
    // red when the list is cut at the first entry, or the separator is not a line break
    expect(notReinstalledApps(BODY_TWO)).toEqual([
      { name: "R709 Probe Target", publisher: "LethAL Probe" },
      { name: "R709 Probe Dep One", publisher: "LethAL Probe" },
      { name: "R709 Probe Dep Two", publisher: "LethAL Probe" },
    ]);
  });

  it("one dependent", () => {
    expect(notReinstalledApps(BODY_ONE)).toEqual([
      { name: "R709 Probe Target Solo", publisher: "LethAL Probe" },
      { name: "R709 Probe Dep Solo", publisher: "LethAL Probe" },
    ]);
  });

  it("the raw JSON body, line breaks escaped as \\n (as a client printing the body shows it)", () => {
    const raw = JSON.stringify({ Message: BODY_TWO, ErrorType: "InvalidOperation" });
    // red when only real line breaks separate entries
    expect(notReinstalledApps(raw)?.map((a) => a.name)).toEqual([
      "R709 Probe Target",
      "R709 Probe Dep One",
      "R709 Probe Dep Two",
    ]);
  });

  it("fail-closed: no list (R-707's 500-char text) is null, never an empty list", () => {
    // red when an unreadable list reads as "nothing was removed"
    expect(notReinstalledApps(R709_RESTORE_TEXT)).toBeNull();
    expect(
      notReinstalledApps(BODY_TWO.replace(/to do so: \n[\s\S]*$/, "to do so: \n\n")),
    ).toBeNull();
  });

  it("the refusal names every listed app, or says it names no readable list", () => {
    const named = new UpgradeNotRestoredError(BODY_TWO).message;
    // red when the parsed names do not reach the message
    expect(named).toContain(
      "BC lists 3 apps it could not reinstall (name by publisher; BC gives no versions): " +
        "R709 Probe Target by LethAL Probe; R709 Probe Dep One by LethAL Probe; " +
        "R709 Probe Dep Two by LethAL Probe.",
    );
    const unread = new UpgradeNotRestoredError(R709_RESTORE_TEXT).message;
    // red when an unreadable list is silently omitted
    expect(unread).toContain(
      "BC's text names no list of the apps it could not reinstall that LethAL can read",
    );
    expect(unread).toContain(R709_RESTORE_TEXT); // BC's text stays, either way
  });

  it("fail-closed: a line not in the '<name> by <publisher>' form voids the whole list", () => {
    const head = BODY_ONE.slice(0, BODY_ONE.indexOf("to do so: \n") + "to do so: \n".length);
    const odd = `${head}Good App by Pub\nNOT AN ENTRY\n\n`;
    // red when an odd line is skipped (a partial list would read as the complete one)
    expect(notReinstalledApps(odd)).toBeNull();
    expect(new UpgradeNotRestoredError(odd).message).toContain("names no list");
  });

  it("a name containing ' by ' splits at the LAST ' by '", () => {
    const head = BODY_ONE.slice(0, BODY_ONE.indexOf("to do so: \n") + "to do so: \n".length);
    // red when the first " by " splits the line
    expect(notReinstalledApps(`${head}Built by Design Tools by Contoso\n\n`)).toEqual([
      { name: "Built by Design Tools", publisher: "Contoso" },
    ]);
  });
});

/** BC's 422 when an upgrade breaks an installed dependent and the old target cannot be put back.
 *  BC's sentence is R-707's bc2 measurement (step 4, a direct HTTP publish; nothing after "If they
 *  are part" was captured); the altool-style "The request for path ..." wrapper is not measured. */
const R709_RESTORE_TEXT =
  "The request for path /BC/dev/apps failed with code UnprocessableEntity. Reason: " +
  "error AL0132: 'Codeunit \"R707 Target\"' does not contain a definition for 'Answer'. " +
  "The original extensions could not be restored due to Cannot install the extension R707 Probe " +
  "Target by LethAL Probe 1.0.0.1 because a newer version 1.0.0.2 was already installed..\n" +
  "Extensions that were previously installed but could not be reinstalled. These extensions " +
  "should be manually reinstalled. If they are part";

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
        sourceVersion: "1.0.0.0",
        nowMs: T0,
        lastIssued: "65535.65535.65535.65535",
      }),
    ).toThrow(VersionOverflowError);
  });

  it("rejects oversized source version components that would exceed the 16-bit limit", () => {
    expect(() =>
      reserveAppVersion({
        sourceVersion: "70000.0.0.0",
        nowMs: T0,
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

  it("R709: returns null for BC's restore-failure text, which embeds the same sentence", () => {
    // red when parseVersionConflict reads the embedded sentence: the run would re-stamp and
    // publish again over a server BC just stripped of the target's dependents
    expect(parseVersionConflict(R709_RESTORE_TEXT)).toBeNull();
    expect(restoreFailed(R709_RESTORE_TEXT)).toBe(true);
  });

  it("R709: a plain downgrade conflict is not a restore failure", () => {
    const plain =
      "Cannot install the extension LethAL Sandbox App by LethAL 1.0.0.999 because a newer " +
      "version 1.0.106.0 was already installed.";
    // red when restoreFailed matches the conflict sentence alone
    expect(restoreFailed(plain)).toBe(false);
    expect(parseVersionConflict(plain)).toBe("1.0.106.0");
  });
});

describe("confirmedDowngradeRefusal (R250)", () => {
  const APP = { name: "LethAL Sandbox App", publisher: "LethAL", version: "1.0.0.999" };
  // Measured live against Cronus281, 2026-07-19 (layer-5a design spec, app-version.ts).
  const REAL =
    "Cannot install the extension LethAL Sandbox App by LethAL 1.0.0.999 because a newer version 1.0.106.0 was already installed.";

  it("accepts BC's measured sentence naming this app, publisher and version", () => {
    expect(confirmedDowngradeRefusal(REAL, APP)).toBe("1.0.106.0");
    expect(confirmedDowngradeRefusal(`altool publishapp failed (exit 1):\n${REAL}`, APP)).toBe(
      "1.0.106.0",
    );
  });

  it("accepts it inside BC's own wrapper, where a second copy names the restore version", () => {
    // Shape measured by the 2026-07-20 concurrent-race probe (fixtures/README.md, Probe B).
    const wrapped = `Publishing failed due to '${REAL}'. The original extensions could not be restored due to Cannot install the extension LethAL Sandbox App by LethAL 1.0.0.998 because a newer version 1.0.106.0 was already installed..`;
    expect(confirmedDowngradeRefusal(wrapped, APP)).toBe("1.0.106.0");
    expect(confirmedDowngradeRefusal(wrapped, { ...APP, version: "1.0.0.997" })).toBeNull();
  });

  it("refuses the phrase quoted inside a timeout message", () => {
    const msg =
      'altool publishapp timed out after 600 s; last line: "a newer version 1.0.106.0 was already installed."';
    expect(confirmedDowngradeRefusal(msg, APP)).toBeNull();
  });

  it("refuses another app's name, another publisher, and another attempted version", () => {
    expect(confirmedDowngradeRefusal(REAL, { ...APP, name: "LethAL Sandbox Tests" })).toBeNull();
    expect(confirmedDowngradeRefusal(REAL, { ...APP, publisher: "Contoso" })).toBeNull();
    expect(confirmedDowngradeRefusal(REAL, { ...APP, version: "1.0.0.99" })).toBeNull();
  });

  it("escapes the names: a '.' in the app name is not a wildcard", () => {
    const msg = REAL.replace("LethAL Sandbox App", "AxB");
    expect(confirmedDowngradeRefusal(msg, { ...APP, name: "A.B" })).toBeNull();
    const own = REAL.replace("LethAL Sandbox App", "A.B (x)");
    expect(confirmedDowngradeRefusal(own, { ...APP, name: "A.B (x)" })).toBe("1.0.106.0");
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

describe("compareAppVersions", () => {
  /**
   * THE reason this function exists rather than a `<` on the strings, and the case that makes the
   * bug invisible in review: lexically `"1.0.0.10" < "1.0.0.9"`, because '1' sorts below '9'. Every
   * hand-written version in this repo is single-digit, so a string compare looks right until a
   * component reaches two digits — which `reserveAppVersion`'s day/half-second components do on
   * their first use.
   */
  it("orders a multi-digit component numerically, not lexically", () => {
    expect(compareAppVersions("1.0.0.10", "1.0.0.9")).toBeGreaterThan(0);
    expect(compareAppVersions("1.0.0.9", "1.0.0.10")).toBeLessThan(0);
    // Both of these are ALSO lexically inverted, in the build component rather than the revision.
    expect(compareAppVersions("1.0.20653.0", "1.0.9999.0")).toBeGreaterThan(0);
    expect(compareAppVersions("1.0.106.0", "1.0.99.0")).toBeGreaterThan(0);
  });

  it("reports equal versions as 0", () => {
    expect(compareAppVersions("1.0.0.7", "1.0.0.7")).toBe(0);
    expect(compareAppVersions("28.0.46665.50383", "28.0.46665.50383")).toBe(0);
  });

  it("weighs components left to right", () => {
    // A larger minor/build/revision never outranks a larger major.
    expect(compareAppVersions("2.0.0.0", "1.65535.65535.65535")).toBeGreaterThan(0);
    expect(compareAppVersions("1.2.0.0", "1.1.65535.65535")).toBeGreaterThan(0);
    expect(compareAppVersions("1.1.2.0", "1.1.1.65535")).toBeGreaterThan(0);
  });

  it("throws on a version that is not four-part, rather than ranking it", () => {
    expect(() => compareAppVersions("1.0.0", "1.0.0.0")).toThrow(/four-part/);
    expect(() => compareAppVersions("1.0.0.0", "1.0.0.0.0")).toThrow(/four-part/);
    expect(() => compareAppVersions("", "1.0.0.0")).toThrow(/four-part/);
  });

  it("throws on a non-numeric or negative component", () => {
    expect(() => compareAppVersions("1.0.0.x", "1.0.0.0")).toThrow(/non-negative integer/);
    expect(() => compareAppVersions("1.0.0.-1", "1.0.0.0")).toThrow(/non-negative integer/);
  });

  it("throws on a component BC's 16-bit version fields cannot hold", () => {
    expect(() => compareAppVersions("1.0.0.65536", "1.0.0.0")).toThrow(VersionOverflowError);
  });
});
