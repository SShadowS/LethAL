import { describe, expect, it } from "bun:test";
import {
  comparePublishedTestApp,
  parsePublishedApp,
  publishedTestAppWarning,
} from "../src/published-test-app";
import { buildFakeAppWithEntries } from "./helpers/fake-app";

/**
 * R139 check 2 — reading the PUBLISHED test app's identity and comparing it against the local
 * source, BEFORE the baseline round-trip that check 1 refuses on.
 *
 * The condition these tests describe has cost a full live gate run twice (2026-08-13 and
 * 2026-08-14): the test app on the container was one version behind the source being measured, so
 * every test the source declared but the app lacked failed at baseline and every mutant covered
 * only by those tests was recorded `no-coverage` — a plausible aggregate for a suite that never ran.
 */

const MANIFEST = (version: string) =>
  `<?xml version="1.0" encoding="utf-8"?>\r\n<Package xmlns="http://schemas.microsoft.com/navx/2015/manifest">\r\n  <App Id="ae4589f8-4376-41a5-acf3-8df73772fefd" Name="LethAL Sandbox Data Tests" Publisher="LethAL" Version="${version}" Runtime="13.0" />\r\n</Package>`;

const TEST_SOURCE = `codeunit 79310 "Data Tests"
{
    Subtype = Test;

    [Test]
    procedure AlreadyPublished()
    begin
    end;
}`;

const GROWN_SOURCE = `codeunit 79310 "Data Tests"
{
    Subtype = Test;

    [Test]
    procedure AlreadyPublished()
    begin
    end;

    [Test]
    procedure JustAdded()
    begin
    end;
}`;

function publishedPackage(version: string, source?: string): Buffer {
  return buildFakeAppWithEntries({
    "NavxManifest.xml": MANIFEST(version),
    ...(source !== undefined ? { "src/src/DataTests.Codeunit.al": source } : {}),
    "SymbolReference.json": JSON.stringify({ Codeunits: [] }),
  });
}

describe("parsePublishedApp", () => {
  it("reads the version from the manifest and the tests from the package's own source", () => {
    const published = parsePublishedApp(publishedPackage("1.0.0.11", TEST_SOURCE));
    expect(published.version).toBe("1.0.0.11");
    expect(published.tests).toEqual(["Data Tests.AlreadyPublished"]);
  });

  it("reports tests as UNKNOWN, not empty, when the package carries no source", () => {
    // A publisher may exclude source. Reporting an empty test set would make every locally
    // declared test look missing — a confident wrong diagnosis, which is worse than none.
    const published = parsePublishedApp(publishedPackage("1.0.0.11"));
    expect(published.version).toBe("1.0.0.11");
    expect(published.tests).toBeUndefined();
  });

  it("throws when the package has no manifest at all, rather than guessing a version", () => {
    const notAnApp = buildFakeAppWithEntries({ "readme.txt": "not a package" });
    expect(() => parsePublishedApp(notAnApp)).toThrow(/NavxManifest/);
  });
});

describe("comparePublishedTestApp", () => {
  const local = {
    version: "1.0.0.12",
    tests: ["Data Tests.AlreadyPublished", "Data Tests.JustAdded"],
  };

  it("names the tests the published app does not declare", () => {
    const c = comparePublishedTestApp(
      local,
      parsePublishedApp(publishedPackage("1.0.0.11", TEST_SOURCE)),
    );
    expect(c.missingTests).toEqual(["Data Tests.JustAdded"]);
    expect(c.publishedVersion).toBe("1.0.0.11");
    expect(c.localVersion).toBe("1.0.0.12");
    expect(c.testsComparable).toBe(true);
  });

  it("finds nothing missing when the published app carries the same tests", () => {
    const c = comparePublishedTestApp(
      local,
      parsePublishedApp(publishedPackage("1.0.0.12", GROWN_SOURCE)),
    );
    expect(c.missingTests).toEqual([]);
    expect(publishedTestAppWarning(c)).toBeUndefined();
  });

  it("says the test set could not be compared when the package carries no source", () => {
    const c = comparePublishedTestApp(local, parsePublishedApp(publishedPackage("1.0.0.12")));
    expect(c.testsComparable).toBe(false);
    expect(c.missingTests).toEqual([]);
  });
});

describe("publishedTestAppWarning", () => {
  const local = {
    version: "1.0.0.12",
    tests: ["Data Tests.AlreadyPublished", "Data Tests.JustAdded"],
  };

  it("names every missing test and carries the remedy", () => {
    const text =
      publishedTestAppWarning(
        comparePublishedTestApp(
          local,
          parsePublishedApp(publishedPackage("1.0.0.11", TEST_SOURCE)),
        ),
      ) ?? "";
    expect(text).toContain("Data Tests.JustAdded");
    expect(text).not.toContain("Data Tests.AlreadyPublished");
    expect(text).toContain("1.0.0.11");
    expect(text).toContain("1.0.0.12");
    expect(text).toContain("Recompile the target into the test project's .alpackages");
  });

  it("reports a version difference on its own, without claiming anything is missing", () => {
    // The test SET matches, so the run is measuring the suite the source declares. The versions
    // still differ, which is worth printing and is not worth alarming about.
    const c = comparePublishedTestApp(
      local,
      parsePublishedApp(publishedPackage("1.0.0.9", GROWN_SOURCE)),
    );
    const text = publishedTestAppWarning(c) ?? "";
    expect(text).toContain("1.0.0.9");
    expect(text).toContain("declares every test");
    expect(text).not.toContain("missing");
  });

  it("stays silent when versions match and no source is available to compare", () => {
    // Nothing measured, nothing claimed: an equal version with no comparable source is exactly the
    // case a version string cannot settle, and inventing a warning here would train the operator
    // to ignore the check.
    const c = comparePublishedTestApp(local, parsePublishedApp(publishedPackage("1.0.0.12")));
    expect(publishedTestAppWarning(c)).toBeUndefined();
  });

  it("reports a version difference when the source cannot be compared", () => {
    const c = comparePublishedTestApp(local, parsePublishedApp(publishedPackage("1.0.0.9")));
    const text = publishedTestAppWarning(c) ?? "";
    expect(text).toContain("1.0.0.9");
    expect(text).toContain("could not be compared");
  });
});
