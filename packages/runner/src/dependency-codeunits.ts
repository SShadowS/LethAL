/**
 * R888: the codeunit ids the target's dependencies declare, so the three injected codeunit ids can
 * avoid them (alc AL0264).
 *
 * WHICH SET. The closure alc compiles against: the target's direct dependencies (app.json), the
 * `Application` meta app when app.json names an `application` version (it reaches Base Application,
 * System Application and Business Foundation), and every dependency each package's own
 * `NavxManifest.xml` lists. AL0264 is about any app the compile sees, not only direct ones. Not
 * included: the platform package `System` (not a dependency; its codeunits sit far below any app id
 * range) and packages in the folders that no dependency reaches.
 *
 * Packages come from the folders the compile already reads, through `packageFolderReader` (same
 * index, same unwrap of Ready-to-Run wrappers) and `declaredObjectsOfPackage` (same symbol reader
 * the object-clash check uses). When a folder holds several versions of an app, all are read:
 * the check may then refuse an id only an older copy declares, which is the safe direction.
 *
 * NEVER SILENT. A package that cannot be found or read is returned in `unread`, with its name; the
 * caller says out loud that the check could not run for it.
 */
import type { DependencyCodeunit } from "@lethal/schemata";
import { readPackageEntry } from "./app-package";
import {
  APPLICATION_APP_ID,
  type AppDependency,
  appInputsOfAppJson,
  appInputsOfManifest,
  packageFolderReader,
} from "./digest-inputs";
import { declaredObjectsOfPackage } from "./object-clash";
import { readAppIdentity, unwrapSymbolPackage } from "./published-test-app";

export interface DependencyCodeunits {
  readonly codeunits: Map<number, DependencyCodeunit>;
  /** One line per dependency whose package was missing or unreadable. Empty when all were read. */
  readonly unread: string[];
}

export async function dependencyCodeunitsOf(
  appManifest: unknown,
  packageDirs: readonly string[],
): Promise<DependencyCodeunits> {
  const read = packageFolderReader(packageDirs);
  const codeunits = new Map<number, DependencyCodeunit>();
  const unread: string[] = [];
  const seen = new Set<string>();
  const queue: AppDependency[] = [];
  const enqueue = (i: ReturnType<typeof appInputsOfAppJson>): void => {
    queue.push(...i.dependencies);
    if (i.application !== undefined) {
      queue.push({
        id: APPLICATION_APP_ID,
        name: "Application",
        publisher: "Microsoft",
        version: i.application,
      });
    }
  };
  try {
    enqueue(appInputsOfAppJson(appManifest));
  } catch (err) {
    return { codeunits, unread: [`app.json dependencies: ${String(err)}`] };
  }
  for (let dep = queue.shift(); dep !== undefined; dep = queue.shift()) {
    if (seen.has(dep.id)) continue;
    seen.add(dep.id);
    const who = `"${dep.name}" (${dep.publisher || "unknown publisher"}, ${dep.id})`;
    const packages = await read(dep);
    if ("unread" in packages || packages.length === 0) {
      unread.push(`${who}: ${"unread" in packages ? packages.unread : "no package found"}`);
      continue;
    }
    for (const bytes of packages) {
      const declared = declaredObjectsOfPackage(bytes);
      if ("unreadable" in declared) {
        unread.push(`${who}: ${declared.unreadable}`);
        continue;
      }
      try {
        const app = unwrapSymbolPackage(
          Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        );
        const identity = readAppIdentity(app);
        const manifest = readPackageEntry(app, "NavxManifest.xml");
        if (manifest !== null) enqueue(appInputsOfManifest(manifest.toString("utf8")));
        for (const o of declared.objects) {
          if (o.kind !== "Codeunit" || codeunits.has(o.id)) continue;
          codeunits.set(o.id, {
            type: "codeunit",
            id: o.id,
            name: o.name,
            app: { name: identity.name, publisher: identity.publisher, version: identity.version },
          });
        }
      } catch (err) {
        unread.push(`${who}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return { codeunits, unread };
}

/** The one warning line for a check that could not read every dependency, or `undefined`. */
export function dependencyCheckWarning(unread: readonly string[]): string | undefined {
  if (unread.length === 0) return undefined;
  return (
    `[lethal] selector ids: could not check them against ${unread.length} dependency package(s), ` +
    `so a clash with those apps' codeunits (alc AL0264) is NOT ruled out: ${unread.join("; ")}`
  );
}
