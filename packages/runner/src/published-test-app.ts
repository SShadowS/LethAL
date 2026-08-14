import { listPackageEntries, readPackageEntry } from "./app-package";
import { testsInAlSource } from "./discovery";
import { STALE_TEST_APP_REMEDY } from "./stale-test-app";

/**
 * R139 check 2 — ask the SERVER what test app it has, before measuring anything.
 *
 * Check 1 (`stale-test-app.ts`) refuses once the server has already answered "found 0" for a test
 * the source declares. It works, and it is reactive: the operator pays a whole baseline round trip
 * to learn it, which on the table fixture is minutes. This module answers the same question from a
 * single read taken before the baseline starts.
 *
 * WHAT IS COMPARED, AND WHY NOT A VERSION STRING ALONE. The row asked for identity rather than
 * versions, and the reason is recorded on it: the second time this bit, the test project's
 * `.alpackages` held a stale BUILD of the target at an UNCHANGED version string, so a version
 * comparison would have reported everything in order. The published package the dev endpoint hands
 * back carries the app's own AL SOURCE, so the strong comparison is available without LethAL
 * compiling the test app it deliberately does not own: parse the published source with the SAME
 * parser discovery uses locally and compare the declared test sets. The version is compared too and
 * reported, because it is what an operator recognises, but it is never the only evidence.
 *
 * WHAT IT DOES NOT DO. It does not refuse. A mismatch is not automatically an error — an operator
 * may deliberately measure an older test app — and check 1 still refuses on the authoritative
 * signal (the server's own words) if the run really is measuring a suite the source does not
 * describe. Adding a second refusal on a DERIVED signal would risk a false refusal without adding
 * safety.
 */

/** The identity a published `.app` package can be read for. */
export interface PublishedApp {
  /** From `NavxManifest.xml`'s `Version` attribute. */
  readonly version: string;
  /**
   * Qualified test names the PUBLISHED package's own AL source declares.
   *
   * `undefined` means UNKNOWN, never "none": a publisher may exclude source, and reporting an empty
   * set there would make every locally declared test look missing. An empty ARRAY is a real answer
   * (source present, no `[Test]` in it).
   */
  readonly tests?: readonly string[];
}

/** What the local project declares, for `comparePublishedTestApp` to compare against. */
export interface LocalTestApp {
  /** From the test project's `app.json`. */
  readonly version: string;
  /** Qualified test names `discoverTests` found in the test project's source. */
  readonly tests: readonly string[];
}

export interface PublishedTestAppComparison {
  readonly localVersion: string;
  readonly publishedVersion: string;
  /** Locally declared tests the published package does not declare, sorted. Empty when comparable and equal. */
  readonly missingTests: readonly string[];
  /** False when the published package carried no source, so only versions could be compared. */
  readonly testsComparable: boolean;
}

/** `App` element attributes live on one line in every package BC produces; read the version off it. */
const MANIFEST_ENTRY = "NavxManifest.xml";
const VERSION_ATTRIBUTE = /<App\b[^>]*\bVersion="([^"]+)"/;

/** Package paths whose contents are AL source. BC nests the project's own layout under `src/`. */
function isAlSourceEntry(name: string): boolean {
  return name.toLowerCase().endsWith(".al");
}

/**
 * Reads a published `.app` package's identity.
 *
 * Throws when the package carries no manifest or no readable version: that is a corrupt or
 * unexpected payload, and this project's convention is to fail loudly on one rather than return a
 * plausible default. The CALLER decides whether an unreadable package should stop anything — for
 * check 2 it never does.
 */
export function parsePublishedApp(pkg: Buffer): PublishedApp {
  const manifest = readPackageEntry(pkg, MANIFEST_ENTRY);
  if (manifest === null) {
    throw new Error(
      `published package carries no ${MANIFEST_ENTRY}, so it is not a BC app package (entries: ${listPackageEntries(pkg).slice(0, 10).join(", ")})`,
    );
  }
  const match = VERSION_ATTRIBUTE.exec(manifest.toString("utf8"));
  const version = match?.[1];
  if (version === undefined) {
    throw new Error(`published package's ${MANIFEST_ENTRY} carries no App Version attribute`);
  }

  const sourceEntries = listPackageEntries(pkg).filter(isAlSourceEntry);
  if (sourceEntries.length === 0) return { version };

  const tests: string[] = [];
  for (const entry of sourceEntries) {
    const source = readPackageEntry(pkg, entry);
    if (source === null) continue;
    for (const ref of testsInAlSource(entry, source.toString("utf8"))) {
      tests.push(`${ref.codeunitName}.${ref.method}`);
    }
  }
  return { version, tests };
}

export function comparePublishedTestApp(
  local: LocalTestApp,
  published: PublishedApp,
): PublishedTestAppComparison {
  const publishedTests = published.tests;
  const testsComparable = publishedTests !== undefined;
  const have = new Set(publishedTests ?? []);
  const missingTests = testsComparable
    ? [...local.tests].filter((t) => !have.has(t)).sort()
    : ([] as string[]);
  return {
    localVersion: local.version,
    publishedVersion: published.version,
    missingTests,
    testsComparable,
  };
}

/**
 * The operator-facing line, or `undefined` when there is nothing to say.
 *
 * Silence on a healthy run is a requirement, not a nicety: a check that speaks every run is a check
 * operators learn to scroll past, and this one has to be read on the two runs a year it matters.
 */
export function publishedTestAppWarning(c: PublishedTestAppComparison): string | undefined {
  const versions = `the container has ${c.publishedVersion}, this project's app.json declares ${c.localVersion}`;

  if (c.missingTests.length > 0) {
    return (
      `[lethal] the published test app does not declare ${c.missingTests.length} test(s) this project's source does (${versions}): ` +
      `${c.missingTests.join(", ")}. Those tests cannot run, so every mutant covered only by them would be recorded no-coverage ` +
      `and the run would report a plausible score for a suite that never ran. ${STALE_TEST_APP_REMEDY}`
    );
  }
  if (c.publishedVersion === c.localVersion) return undefined;
  if (!c.testsComparable) {
    return `[lethal] the published test app's version differs from this project's (${versions}), and its test set could not be compared because the published package carries no source. If you have not published the current test project, do that before reading any number in this report.`;
  }
  return `[lethal] the published test app's version differs from this project's (${versions}), but it declares every test this project's source does, so the suite being measured is the one the source describes. A matching test set is not a matching build: test BODIES may still differ.`;
}
