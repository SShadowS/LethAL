/**
 * R-371: the two things a test's digest covers that are not test-app source.
 *
 * 1. The BUILD INPUTS: what in `app.json` changes what compiles (`preprocessorSymbols`, `runtime`,
 *    `features`, `target`, `application`, `platform`). A bcdev run reads them from the PUBLISHED
 *    package's NavxManifest (R-372's rule: the body the server runs), verify and al-runner from the
 *    test project's `app.json`, so both are read into one canonical text that compares equal when
 *    they say the same thing.
 * 2. The DEPENDENCY FINGERPRINT: every dependency the test app runs against, transitive ones too.
 *    A Microsoft one by publisher, id and version: rebuilding one at an UNCHANGED version is not
 *    seen, a stated limit (filed on the roadmap). Every other one by the SHA-256 of the package
 *    that RAN: read one at a time, hashed and dropped. The target app itself is left out: verify
 *    requires its source unchanged (`assertSourceUnchanged`), and the package the server holds for
 *    it is the instrumented build of whichever run published last. Its own dependencies are taken
 *    from the target project's `app.json` and walked like any other.
 *
 * A package that cannot be read throws `DependencyUnreadableError`: the run then records no
 * digests (`test-digests-unavailable`) and verify refuses, never a partial fingerprint.
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { readPackageEntry } from "./app-package";
import { CONTROL_APP_ID } from "./harness";
import { readAppIdentity } from "./published-test-app";

export interface AppDependency {
  /** Lowercase GUID. */
  readonly id: string;
  readonly name: string;
  readonly publisher: string;
  /** app.json's `version`, the manifest's `MinVersion`: the declared minimum, not the resident. */
  readonly version: string;
}

export interface AppInputs {
  readonly dependencies: readonly AppDependency[];
  readonly application: string | undefined;
  readonly platform: string | undefined;
  /** The canonical build-inputs text, equal for a manifest and the app.json it was built from. */
  readonly buildInputs: string;
}

export class DependencyUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DependencyUnreadableError";
  }
}

function canonicalBuildInputs(i: {
  runtime: string | undefined;
  target: string | undefined;
  features: readonly string[];
  preprocessorSymbols: readonly string[];
  application: string | undefined;
  platform: string | undefined;
}): string {
  return JSON.stringify({
    runtime: i.runtime ?? "",
    // alc writes Target="Cloud" for an app.json that names none (measured on the fixtures).
    target: (i.target ?? "Cloud").toLowerCase(),
    // The manifest spells a feature in capitals (NOIMPLICITWITH), app.json as written.
    features: [...new Set(i.features.map((f) => f.toLowerCase()))].sort(),
    preprocessorSymbols: [...new Set(i.preprocessorSymbols)].sort(),
    application: i.application ?? "",
    platform: i.platform ?? "",
  });
}

const XML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};
const unescapeXml = (s: string): string =>
  s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => XML_ENTITIES[e] ?? "");
const attrOf = (tag: string, name: string): string | undefined => {
  const v = new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
  return v === undefined ? undefined : unescapeXml(v);
};
/** The text of every child element inside `<block>...</block>`, and every `Name` attribute. */
function listIn(xml: string, block: string): string[] {
  const inner = new RegExp(`<${block}>([\\s\\S]*?)</${block}>`).exec(xml)?.[1];
  if (inner === undefined) return [];
  const out: string[] = [];
  for (const m of inner.matchAll(/>([^<]+)</g)) {
    const t = m[1]?.trim();
    if (t !== undefined && t.length > 0) out.push(unescapeXml(t));
  }
  for (const m of inner.matchAll(/\sName="([^"]*)"/g))
    if (m[1] !== undefined) out.push(unescapeXml(m[1]));
  return out;
}

/** A package's NavxManifest.xml, read into the same shape `appInputsOfAppJson` gives. */
export function appInputsOfManifest(xml: string): AppInputs {
  const app = /<App\b[^>]*>/.exec(xml)?.[0];
  if (app === undefined) throw new DependencyUnreadableError("a manifest carries no App element");
  const dependencies: AppDependency[] = [];
  for (const m of xml.matchAll(/<Dependency\b[^>]*>/g)) {
    const tag = m[0];
    const id = attrOf(tag, "Id");
    if (id === undefined)
      throw new DependencyUnreadableError(`a manifest Dependency has no Id: ${tag}`);
    dependencies.push({
      id: id.toLowerCase(),
      name: attrOf(tag, "Name") ?? "",
      publisher: attrOf(tag, "Publisher") ?? "",
      version: attrOf(tag, "MinVersion") ?? attrOf(tag, "Version") ?? "",
    });
  }
  const application = attrOf(app, "Application");
  const platform = attrOf(app, "Platform");
  return {
    dependencies,
    application,
    platform,
    buildInputs: canonicalBuildInputs({
      runtime: attrOf(app, "Runtime"),
      target: attrOf(app, "Target"),
      features: listIn(xml, "Features"),
      preprocessorSymbols: listIn(xml, "PreprocessorSymbols"),
      application,
      platform,
    }),
  };
}

/** A package's own inputs, from its NavxManifest.xml. */
export function appInputsOfPackage(pkg: Uint8Array): AppInputs {
  const manifest = readPackageEntry(Buffer.from(pkg), "NavxManifest.xml");
  if (manifest === null)
    throw new DependencyUnreadableError("a package carries no NavxManifest.xml");
  return appInputsOfManifest(manifest.toString("utf8"));
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** A parsed `app.json`. */
export function appInputsOfAppJson(json: unknown): AppInputs {
  const j = (typeof json === "object" && json !== null ? json : {}) as Record<string, unknown>;
  const deps = Array.isArray(j.dependencies) ? j.dependencies : [];
  const dependencies = deps.map((d): AppDependency => {
    const r = (typeof d === "object" && d !== null ? d : {}) as Record<string, unknown>;
    // Old app.json files spell it appId.
    const id = str(r.id) ?? str(r.appId);
    if (id === undefined)
      throw new DependencyUnreadableError(`an app.json dependency has no id: ${JSON.stringify(d)}`);
    return {
      id: id.toLowerCase(),
      name: str(r.name) ?? "",
      publisher: str(r.publisher) ?? "",
      version: str(r.version) ?? "",
    };
  });
  const application = str(j.application);
  const platform = str(j.platform);
  return {
    dependencies,
    application,
    platform,
    buildInputs: canonicalBuildInputs({
      runtime: str(j.runtime),
      target: str(j.target),
      features: strings(j.features),
      preprocessorSymbols: strings(j.preprocessorSymbols),
      application,
      platform,
    }),
  };
}

/**
 * `dir/app.json` read. Fails closed: a missing, unreadable or unparseable app.json throws
 * `DependencyUnreadableError`, never empty inputs. A test project always has one (alc needs it),
 * so no absence is supported; empty inputs would give a credible, narrower digest, and two failed
 * reads would compare equal.
 */
export async function readAppJsonInputs(dir: string): Promise<AppInputs> {
  let json: unknown;
  try {
    json = JSON.parse((await readFile(join(dir, "app.json"), "utf8")).replace(/^\uFEFF/, ""));
  } catch (err) {
    throw new DependencyUnreadableError(
      `the test project's app.json (${join(dir, "app.json")}) could not be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return appInputsOfAppJson(json);
}

/**
 * The packages that ran for one dependency: usually one; several when a package folder holds more
 * than one version of it and which one loaded is not known (every one is hashed). `null` when none
 * can be read.
 */
export type PackageReader = (dep: AppDependency) => Promise<ReadonlyArray<Uint8Array> | null>;

const isMicrosoft = (publisher: string): boolean => publisher.trim().toLowerCase() === "microsoft";
const sha256 = (b: Uint8Array | string): string =>
  new Bun.CryptoHasher("sha256").update(b).digest("hex");
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * R-385: Microsoft's `Application` meta app. Every `Microsoft_Application_*.app` manifest under
 * `fixtures/*\/.alpackages` (17) and the package Cronus28 and Cronus284 served carry this App Id.
 * It is walked by id when any walked app declares an `application` property.
 */
export const APPLICATION_APP_ID = "c1335042-3002-4257-bf8a-75c898ccb1b8";

/**
 * R-385: how `dependencyFingerprint` treats Microsoft apps. Required, with no default, so no
 * caller gets either behaviour by leaving it out.
 *
 * - `bytes`: a Microsoft app is hashed by the bytes of the package the SERVER holds, like any
 *   other dependency, and must have exactly one INSTALLED row at the hashed manifest's version.
 *   `System` is always hashed (`readSystem`), and so are the dependencies of the `LethAL Control`
 *   app the server runs (`readControl`, which must report `controlVersion()`): today only Test
 *   Runner, which runs every test.
 * - `declared`: a Microsoft app by id and DECLARED version only (`M <id> <version>`), plus a
 *   `K declared` line so such a fingerprint never equals a bytes one. al-runner's (D6).
 */
export type MicrosoftMode =
  | {
      readonly kind: "bytes";
      readSystem(): Promise<Uint8Array | null | undefined>;
      readControl(): Promise<Uint8Array | null | undefined>;
      controlVersion(): Promise<string>;
      installed(appId: string): Promise<readonly string[]>;
    }
  | { readonly kind: "declared" };

/** A package's identity and manifest, or `DependencyUnreadableError` naming `what`. */
function openPackage(
  bytes: Uint8Array | null | undefined,
  what: string,
): { bytes: Uint8Array; identity: ReturnType<typeof readAppIdentity>; manifest: string } {
  if (bytes === null || bytes === undefined || bytes.byteLength === 0) {
    throw new DependencyUnreadableError(`the package of ${what} could not be read`);
  }
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    const identity = readAppIdentity(buf);
    const manifest = readPackageEntry(buf, "NavxManifest.xml");
    if (manifest === null) throw new Error("no NavxManifest.xml");
    return { bytes, identity, manifest: manifest.toString("utf8") };
  } catch (err) {
    throw new DependencyUnreadableError(
      `the package read for ${what} is not a readable app package: ${message(err)}`,
    );
  }
}

/**
 * The dependency fingerprint of an app whose inputs are `root`. `target` is the app under test,
 * which is not hashed (see the module comment) but whose own dependencies are walked from its
 * project's `app.json`. Packages are read one at a time, and each is dropped once hashed; the
 * lines are sorted, so the walk order does not matter.
 */
export async function dependencyFingerprint(
  root: AppInputs,
  read: PackageReader,
  microsoft: MicrosoftMode,
  target?: { readonly id: string; readonly inputs: AppInputs },
): Promise<string> {
  const lines = new Set<string>();
  const seen = new Set<string>();
  const queue: AppDependency[] = [];
  const bytesMode = microsoft.kind === "bytes" ? microsoft : undefined;
  const enqueue = (i: AppInputs): void => {
    if (i.application !== undefined) {
      lines.add(`M application ${i.application}`);
      // R-385: a real suite reaches Base and System Application through this meta app.
      if (bytesMode !== undefined)
        queue.push({
          id: APPLICATION_APP_ID,
          name: "Application",
          publisher: "Microsoft",
          version: i.application,
        });
    }
    if (i.platform !== undefined) lines.add(`M platform ${i.platform}`);
    queue.push(...i.dependencies);
  };
  if (bytesMode === undefined) {
    lines.add("K declared");
  } else {
    // R-385 platform root: System, always. It is not an extension: no installed check.
    const system = openPackage(await bytesMode.readSystem(), 'the platform package "System"');
    if (system.identity.name !== "System" || !isMicrosoft(system.identity.publisher)) {
      throw new DependencyUnreadableError(
        `the platform package read for "System" is "${system.identity.name}" by "${system.identity.publisher}", not Microsoft's System`,
      );
    }
    lines.add(`P ${sha256(system.bytes)}`);
    enqueue(appInputsOfManifest(system.manifest));
    // R-385 control root: the dependencies of the control app the server RUNS (Test Runner). Its
    // own bytes are not hashed (limit L3); its version proves the served package is the running one.
    const control = openPackage(await bytesMode.readControl(), 'the control app "LethAL Control"');
    if (control.identity.id.toLowerCase() !== CONTROL_APP_ID) {
      throw new DependencyUnreadableError(
        `the package served for the control app "LethAL Control" is app ${control.identity.id} ("${control.identity.name}"), not ${CONTROL_APP_ID}`,
      );
    }
    let running: string;
    try {
      running = await bytesMode.controlVersion();
    } catch (err) {
      throw new DependencyUnreadableError(
        `the running control app "LethAL Control" did not report its version: ${message(err)}`,
      );
    }
    if (control.identity.version !== running) {
      throw new DependencyUnreadableError(
        `the package served for the control app "LethAL Control" is version ${control.identity.version}, but the running one reports ${running}`,
      );
    }
    queue.push(...appInputsOfManifest(control.manifest).dependencies);
  }
  enqueue(root);
  const targetId = target?.id.toLowerCase();
  for (let dep = queue.shift(); dep !== undefined; dep = queue.shift()) {
    if (seen.has(dep.id)) continue;
    seen.add(dep.id);
    if (dep.id === targetId && target !== undefined) {
      lines.add(`T ${dep.id}`);
      enqueue(target.inputs);
      continue;
    }
    if (bytesMode === undefined && isMicrosoft(dep.publisher)) {
      lines.add(`M ${dep.id} ${dep.version}`);
      continue;
    }
    const packages = await read(dep);
    if (packages === null || packages.length === 0) {
      throw new DependencyUnreadableError(
        `the package of dependency "${dep.name}" (${dep.publisher}, ${dep.id}) could not be read`,
      );
    }
    for (const bytes of packages) {
      const { identity, manifest } = openPackage(bytes, `dependency "${dep.name}" (${dep.id})`);
      if (identity.id.toLowerCase() !== dep.id) {
        throw new DependencyUnreadableError(
          `the package read for dependency "${dep.name}" (${dep.id}) is app ${identity.id} ("${identity.name}"), not that dependency`,
        );
      }
      if (
        bytesMode !== undefined &&
        (isMicrosoft(dep.publisher) || isMicrosoft(identity.publisher))
      )
        await checkInstalled(bytesMode, dep, identity.version);
      lines.add(`X ${dep.id} ${sha256(bytes)}`);
      enqueue(appInputsOfManifest(manifest));
    }
  }
  return sha256([...lines].sort().join("\n"));
}

/**
 * R-385 D2: a Microsoft package the server serves must be the one INSTALLED: exactly one installed
 * row, at the hashed manifest's version. `dev/packages` returns "a version you have", which during
 * a staged upgrade may be published but not installed; hashing that would call it resident.
 */
async function checkInstalled(
  mode: Extract<MicrosoftMode, { kind: "bytes" }>,
  dep: AppDependency,
  served: string,
): Promise<void> {
  let installed: readonly string[];
  try {
    installed = await mode.installed(dep.id);
  } catch (err) {
    throw new DependencyUnreadableError(
      `the installed version of "${dep.name}" (${dep.id}) could not be read: ${message(err)}`,
    );
  }
  if (installed.length !== 1 || installed[0] !== served) {
    throw new DependencyUnreadableError(
      `"${dep.name}" (${dep.id}): the server serves version ${served}, but its installed version(s) are [${installed.join(", ")}]; exactly one installed row at the served version is required`,
    );
  }
}

/** R-372's read: bcdev's `fetchPublishedAppPackage`, the package the SERVER holds. */
export function publishedPackageReader(
  fetchPackage: (app: {
    readonly publisher: string;
    readonly name: string;
  }) => Promise<Uint8Array | null | undefined>,
): PackageReader {
  return async (dep) => {
    const bytes = await fetchPackage({ publisher: dep.publisher, name: dep.name });
    return bytes === null || bytes === undefined ? null : [bytes];
  };
}

/**
 * al-runner: the `.app` files in the package folders the run hands it (`--package-cache`). The
 * folders are indexed once by app id, reading each package's manifest and dropping the bytes.
 */
export function packageFolderReader(dirs: readonly string[]): PackageReader {
  let index: Map<string, string[]> | undefined;
  const build = async (): Promise<Map<string, string[]>> => {
    const out = new Map<string, string[]>();
    for (const dir of dirs) {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        continue;
      }
      for (const n of names.filter((x) => x.toLowerCase().endsWith(".app")).sort()) {
        const path = join(dir, n);
        let id: string;
        try {
          id = readAppIdentity(await readFile(path)).id.toLowerCase();
        } catch {
          continue; // not an app package: it cannot be the dependency either
        }
        const list = out.get(id);
        if (list === undefined) out.set(id, [path]);
        else list.push(path);
      }
    }
    return out;
  };
  return async (dep) => {
    index ??= await build();
    const paths = index.get(dep.id);
    if (paths === undefined) return null;
    return Promise.all(paths.map(async (p) => new Uint8Array(await readFile(p))));
  };
}

/** The app under test, for `dependencyFingerprint`'s `target`: its project's app.json. */
export async function targetOf(
  projectDir: string,
): Promise<{ readonly id: string; readonly inputs: AppInputs }> {
  let json: unknown;
  try {
    json = JSON.parse(
      (await readFile(join(projectDir, "app.json"), "utf8")).replace(/^\uFEFF/, ""),
    );
  } catch (err) {
    throw new DependencyUnreadableError(
      `the target project's app.json could not be read (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  const id = str((json as Record<string, unknown>).id);
  if (id === undefined)
    throw new DependencyUnreadableError("the target project's app.json has no id");
  return { id: id.toLowerCase(), inputs: appInputsOfAppJson(json) };
}

/**
 * The bcdev step on its own (the build measures its live cost with it: see
 * scripts/r371-reach-measure/dep-download.ts). Reads the PUBLISHED test app for its dependency
 * list, then every non-Microsoft dependency's resident package.
 */
export async function bcdevDependencyFingerprint(
  fetchPackage: (app: {
    readonly publisher: string;
    readonly name: string;
  }) => Promise<Uint8Array | null | undefined>,
  testDir: string,
  projectDir: string,
  microsoft: MicrosoftMode,
): Promise<string> {
  const local = JSON.parse(
    (await readFile(join(testDir, "app.json"), "utf8")).replace(/^\uFEFF/, ""),
  ) as {
    name?: unknown;
    publisher?: unknown;
  };
  const name = str(local.name);
  const publisher = str(local.publisher);
  if (name === undefined || publisher === undefined)
    throw new DependencyUnreadableError("the test project's app.json names no name and publisher");
  const bytes = await fetchPackage({ publisher, name });
  if (bytes === null || bytes === undefined)
    throw new DependencyUnreadableError(`the published test app "${name}" could not be read`);
  return dependencyFingerprint(
    appInputsOfPackage(bytes),
    publishedPackageReader(fetchPackage),
    microsoft,
    await targetOf(projectDir),
  );
}
