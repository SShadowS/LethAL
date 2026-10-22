/**
 * R599: what a bc server holds for one app, and whether `bc-linux-setup.ts` or `bc-republish.ts`
 * may (re)publish it, decided by CONTENT, not by version.
 *
 * alc builds are not byte-reproducible: a random per-compile id sits in the package header (it is
 * the automation API's `packageId`) and the build timestamp in `NavxManifest.xml`
 * (`/coord/handoff/R-599/measure.md`, F2). So raw sha256 never matches between two builds of one
 * source, and the comparison is `contentDigest`: sha256 over every zip entry, sorted by name, each
 * framed as name, NUL, length, NUL, inflated bytes, with the `<Build Timestamp="...">` attribute
 * removed and `navigation.xml` normalised (`normaliseNavigation`: its random ControlGUIDs and two
 * measured unordered element kinds). Raw sha256 stays the read-back check after a publish (the
 * bytes sent must come back).
 *
 * `decideApp` is the pure decision table (plan r3, rows 1 to 9). `decideAll` / `actAll` run it
 * over a list of apps against one server: decide EVERY app first, and act only if nothing was
 * refused. This module imports only from `packages/` and `node:`, so both scripts can use it
 * without importing each other the wrong way round.
 *
 * Also here, moved down from the two scripts: the server names (`HOST`, `SERVERS`, `Conn`,
 * `publishBytes`, ...), the ONE dev-endpoint package read every script uses (`residentPackage`,
 * strict since R624: only a 404 is "absent", `packageStatus`), the automation API rows (`rows`,
 * ...), `controlAction`, and the fixture manifests (`manifest`, `fixtureManifests`, `dependsOn`).
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { FetchFn } from "../packages/runner/src/activation.ts";
import { listPackageEntries, readPackageEntry } from "../packages/runner/src/app-package.ts";
import { compareAppVersions, parseVersionConflict } from "../packages/runner/src/app-version.ts";
import { bcFetch } from "../packages/runner/src/bc-fetch.ts";
import { devPackagesUrl } from "../packages/runner/src/bcdev-backend.ts";
import { readAppIdentity } from "../packages/runner/src/published-test-app.ts";
import { CONTROL_SELECTOR_FILENAME } from "../packages/schemata/src/project.ts";

const REPO = join(import.meta.dir, "..");
const FIXTURES = join(REPO, "fixtures");
export const COMPANY = "CRONUS International Ltd.";

// ---------------------------------------------------------------------------------------------
// the servers (moved from bc-linux-setup.ts)

export const HOST = "http://192.168.2.157";

export const SERVERS = {
  bc1: { odata: 7048, dev: 7049, api: 7052 },
  bc2: { odata: 7148, dev: 7149, api: 7152 },
  bc3: { odata: 7248, dev: 7249, api: 7252 },
} as const;
export type ServerName = keyof typeof SERVERS;

export interface Conn {
  readonly server: ServerName;
  /** `Basic ...`, built in memory from the secret file. */
  readonly authorization: string;
  /** Tests only: answers every request made through this Conn. Production never sets it. */
  readonly fetch?: FetchFn;
}

/** Every dev-endpoint and API call in this module sends through here (R624: a fake Conn never reaches a server). */
function send(c: Conn): FetchFn {
  return c.fetch ?? bcFetch;
}

function devBase(c: Conn): string {
  return `${HOST}:${SERVERS[c.server].dev}/BC`;
}

export async function publishBytes(c: Conn, fileName: string, bytes: Uint8Array): Promise<void> {
  const params = new URLSearchParams({
    tenant: "default",
    SchemaUpdateMode: "forcesync",
    DependencyPublishingOption: "default",
  });
  const form = new FormData();
  // Wire shape from bc-dev-mcp (measured on Cronus28 BC 28.4): one multipart part named after the file.
  form.append(fileName, new Blob([bytes]), fileName);
  const res = await send(c)(`${devBase(c)}/dev/apps?${params}`, {
    method: "POST",
    headers: { authorization: c.authorization },
    body: form,
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 2000);
    throw new Error(`${c.server}: publishing ${fileName} failed (HTTP ${res.status}): ${text}`);
  }
}

export function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// ---------------------------------------------------------------------------------------------
// the fixture manifests (moved from bc-linux-setup.ts and bc-republish.ts)

export interface AppManifest {
  readonly id?: string;
  readonly name: string;
  readonly publisher: string;
  readonly version: string;
  readonly dependencies?: readonly {
    readonly id?: string;
    readonly name: string;
    readonly publisher: string;
  }[];
}

export function manifest(dir: string): AppManifest {
  return JSON.parse(readFileSync(join(dir, "app.json"), "utf8")) as AppManifest;
}

export function dependsOn(app: AppManifest, target: AppManifest): boolean {
  return (app.dependencies ?? []).some((d) =>
    d.id !== undefined && target.id !== undefined
      ? d.id.toLowerCase() === target.id.toLowerCase()
      : d.name === target.name && d.publisher === target.publisher,
  );
}

export function fixtureManifests(): Map<string, AppManifest> {
  const out = new Map<string, AppManifest>();
  for (const e of readdirSync(FIXTURES)) {
    try {
      out.set(e, manifest(join(FIXTURES, e)));
    } catch {
      // not an AL project
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// the strict dev-endpoint read and the automation API (moved from bc-republish.ts)

export type ControlAction = "publish" | "already-pinned";

/**
 * What `control` does given what the server holds. It only ever publishes UP (an upgrade over the
 * dev endpoint never removes the app); a higher version, or the same version with other contents,
 * is refused rather than removed.
 */
export function controlAction(
  resident: { readonly version: string; readonly sha256: string } | null,
  pinned: { readonly version: string; readonly sha256: string },
): ControlAction {
  if (resident === null) return "publish";
  const cmp = compareAppVersions(resident.version, pinned.version);
  if (cmp < 0) return "publish";
  if (cmp > 0)
    throw new Error(
      `the server holds LethAL Control ${resident.version}, above the pinned ${pinned.version}; refused (no downgrade)`,
    );
  if (resident.sha256 !== pinned.sha256)
    throw new Error(
      `the server holds LethAL Control ${resident.version} with sha256 ${resident.sha256}, not the pinned build ${pinned.sha256}; refused (replacing it would need a removal)`,
    );
  return "already-pinned";
}

/**
 * How `control` reads the dev endpoint's answer for the resident package. ONLY a 404 means the
 * server holds none: any other failure (a 500, a timeout page, a refused login) is an error that
 * stops the run, so a server that could not be read is never taken for one without the control app.
 */
export function packageStatus(status: number): "present" | "absent" {
  if (status >= 200 && status < 300) return "present";
  if (status === 404) return "absent";
  throw new Error(`the dev endpoint answered HTTP ${status} for the resident package; stopped`);
}

/**
 * The package the server holds for publisher/name, or `null` when it holds none. The ONE
 * `dev/packages` read of the setup scripts (R624). Strict: a 404 is the only "none"
 * (`packageStatus`, measured on bc3 for an absent app: `/coord/handoff/R-624/live/0-absent-status.log`);
 * 401/403 is a refused login; any other failure throws, so an unreadable server is never taken
 * for one without the app.
 */
export async function residentPackage(
  c: Conn,
  publisher: string,
  name: string,
): Promise<Buffer | null> {
  const url = devPackagesUrl(
    { server: HOST, serverInstance: "BC", tenant: "default", port: SERVERS[c.server].dev },
    { publisher, name },
  );
  if (url === null) throw new Error("unreachable: devPackagesUrl refused a fixed URL");
  const res = await send(c)(url, { headers: { authorization: c.authorization } });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`${c.server}: the dev endpoint refused the login (HTTP ${res.status})`);
  }
  let state: "present" | "absent";
  try {
    state = packageStatus(res.status);
  } catch (err) {
    throw new Error(`${c.server}: ${publisher} "${name}": ${(err as Error).message}`);
  }
  if (state === "absent") return null;
  return Buffer.from(await res.arrayBuffer());
}

export async function apiJson(c: Conn, url: string, method = "GET") {
  const res = await send(c)(url, {
    method,
    headers: {
      authorization: c.authorization,
      accept: "application/json",
      "content-type": "application/json",
    },
  });
  const text = await res.text();
  if (res.status === 401 || res.status === 403)
    throw new Error(`${c.server}: the API refused the login (HTTP ${res.status})`);
  return {
    status: res.status,
    ok: res.ok,
    text,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

export interface ExtensionRow {
  readonly packageId: string;
  readonly displayName: string;
  readonly isInstalled: boolean;
  readonly versionMajor: number;
  readonly versionMinor: number;
  readonly versionBuild: number;
  readonly versionRevision: number;
}

export const rowVersion = (r: ExtensionRow) =>
  `${r.versionMajor}.${r.versionMinor}.${r.versionBuild}.${r.versionRevision}`;

export async function extensionsApi(c: Conn): Promise<string> {
  const api = `${HOST}:${SERVERS[c.server].api}/BC/api`;
  const cs = await apiJson(c, `${api}/v2.0/companies?tenant=default`);
  if (!cs.ok) throw new Error(`${c.server}: companies: HTTP ${cs.status}`);
  const company = (cs.body.value as { id: string; name: string }[]).find((x) => x.name === COMPANY);
  if (company === undefined) throw new Error(`${c.server}: company ${COMPANY} not found`);
  return `${api}/microsoft/automation/v2.0/companies(${company.id})/extensions`;
}

export async function rows(c: Conn, ext: string, appId: string): Promise<ExtensionRow[]> {
  const r = await apiJson(
    c,
    `${ext}?tenant=default&$filter=${encodeURIComponent(`id eq ${appId}`)}`,
  );
  if (!r.ok) throw new Error(`${c.server}: extensions filter: HTTP ${r.status}`);
  return r.body.value as ExtensionRow[];
}

// ---------------------------------------------------------------------------------------------
// the content identity

/** The package's content cannot be identified; the decision is `refuse content-unknown`. */
export class ContentUnknownError extends Error {}

const MANIFEST = "NavxManifest.xml";
const TIMESTAMP = /(<Build\b[^>]*?)\s+Timestamp="[^"]*"/g;
const NAVIGATION = "navigation.xml";
const CONTROL_GUID = /(\sControlGUID=")[^"]*(")/g;
/** The two self-closing element kinds whose sibling order alc does not fix (measured, R599). */
const UNORDERED = [
  String.raw`<ActionChange\b[^>]*\/>`,
  String.raw`<Actions xsi:type="ActionDefinition"[^>]*\/>`,
];

/** Sorts each run of sibling `element`s (only whitespace between them), keeping the whitespace. */
function sortRuns(text: string, element: string): string {
  const one = new RegExp(element, "g");
  const run = new RegExp(`${element}(?:\\s*${element})+`, "g");
  return text.replace(run, (r) => {
    const sorted = (r.match(one) ?? []).sort();
    let i = 0;
    return r.replace(one, () => sorted[i++] ?? "");
  });
}

/**
 * R599, measured (`/coord/handoff/R-599/nondeterminism*.log`): alc writes a random `ControlGUID` per
 * action into `navigation.xml` on every compile, and lists a parent's self-closing `<ActionChange/>`
 * children, and its self-closing `<Actions xsi:type="ActionDefinition"/>` children, in no fixed order.
 * Inside `navigation.xml` ONLY: every `ControlGUID` value is blanked, and each run of direct sibling
 * elements of exactly those two kinds is put in a canonical order (sorted by each element's full text
 * after the blanking; every element kept, duplicates included). Group elements (which have children)
 * and everything else are left as they are.
 */
export function normaliseNavigation(text: string): string {
  return UNORDERED.reduce(sortRuns, text.replace(CONTROL_GUID, "$1$2"));
}

/** Each entry's bytes as the digest hashes them (the manifest without its build timestamp). */
function normalisedEntries(pkg: Buffer): Map<string, Buffer> {
  let names: readonly string[];
  try {
    names = listPackageEntries(pkg);
  } catch (err) {
    throw new ContentUnknownError(`not a readable package: ${(err as Error).message}`);
  }
  if (names.length === 0) throw new ContentUnknownError("the package has no entries");
  const out = new Map<string, Buffer>();
  for (const name of names) {
    // `readPackageEntry` returns the FIRST copy of a name, so a second copy would never be hashed.
    if (out.has(name)) throw new ContentUnknownError(`the package holds ${name} twice`);
    const bytes = readPackageEntry(pkg, name);
    if (bytes === null) throw new ContentUnknownError(`entry ${name} cannot be read`);
    out.set(name, bytes);
  }
  const m = out.get(MANIFEST);
  if (m === undefined) throw new ContentUnknownError(`the package has no ${MANIFEST}`);
  const text = m.toString("utf8");
  const hits = text.match(TIMESTAMP)?.length ?? 0;
  // A future alc that moved the timestamp would otherwise make every app look changed, silently.
  if (hits !== 1)
    throw new ContentUnknownError(`${MANIFEST} has ${hits} Build Timestamp attributes, not 1`);
  out.set(MANIFEST, Buffer.from(text.replace(TIMESTAMP, "$1"), "utf8"));
  const nav = out.get(NAVIGATION);
  if (nav !== undefined)
    out.set(NAVIGATION, Buffer.from(normaliseNavigation(nav.toString("utf8")), "utf8"));
  return out;
}

/** The normalised content digest (see the module header). Throws `ContentUnknownError`. */
export function contentDigest(pkg: Buffer): string {
  const entries = normalisedEntries(pkg);
  const h = createHash("sha256");
  for (const name of [...entries.keys()].sort()) {
    const bytes = entries.get(name) as Buffer;
    h.update(name).update("\0").update(String(bytes.length)).update("\0").update(bytes);
  }
  return h.digest("hex");
}

/** The entry names whose normalised bytes differ between two packages, sorted. */
export function changedEntries(a: Buffer, b: Buffer): string[] {
  const ea = normalisedEntries(a);
  const eb = normalisedEntries(b);
  const names = [...new Set([...ea.keys(), ...eb.keys()])].sort();
  return names.filter((n) => {
    const x = ea.get(n);
    const y = eb.get(n);
    return x === undefined || y === undefined || !x.equals(y);
  });
}

/** `NavxManifest.xml`'s `<Build CompilerVersion>`, or "unknown". */
export function compilerVersion(pkg: Buffer): string {
  const m = readPackageEntry(pkg, MANIFEST)?.toString("utf8") ?? "";
  return /<Build\b[^>]*\sCompilerVersion="([^"]*)"/.exec(m)?.[1] ?? "unknown";
}

/** A gate's instrumented build: it carries LethAL's selector codeunit (`src/` + the file name). */
export function isInstrumented(pkg: Buffer): boolean {
  return listPackageEntries(pkg).includes(`src/${CONTROL_SELECTOR_FILENAME}`);
}

/** The package header's per-compile id (bytes 12 to 27) in .NET GUID order: its `packageId`. */
export function headerPackageId(pkg: Buffer): string {
  const b = pkg.subarray(12, 28);
  if (b.length !== 16) throw new ContentUnknownError("the package has no 40-byte header");
  const h = (s: Buffer) => s.toString("hex");
  const rev = (s: Buffer) => h(Buffer.from(s).reverse());
  return `${rev(b.subarray(0, 4))}-${rev(b.subarray(4, 6))}-${rev(b.subarray(6, 8))}-${h(b.subarray(8, 10))}-${h(b.subarray(10, 16))}`;
}

export function describeRows(rs: readonly ExtensionRow[]): string {
  if (rs.length === 0) return "rows: none";
  return `rows: ${rs.map((r) => `${rowVersion(r)} installed=${r.isInstalled} packageId=${r.packageId}`).join("; ")}`;
}

// ---------------------------------------------------------------------------------------------
// the decision (plan r3, rows 1 to 9)

export type Mode = "setup" | "republish";

export interface DecideInput {
  /** The fixture directory, as `--mint` names it. */
  readonly dir: string;
  readonly local: Buffer;
  /** The `dev/packages` download (strict: `null` only on a 404). */
  readonly resident: Buffer | null;
  readonly rows: readonly ExtensionRow[];
  readonly role: "target" | "dependent";
  /** `PUBLISH_PLAN` marks the target as one a gate deploys itself. */
  readonly gateDeploys: boolean;
  /** An installed fixture app that depends on this one, by name, or null. */
  readonly installedDependent: string | null;
  readonly mode: Mode;
}

export type Decision =
  | {
      readonly action: "publish";
      readonly how: "new" | "upgrade" | "in place";
      readonly line: string;
      /** In place: which entries differ, both digests and both compilers (F2, M3). */
      readonly changed?: string;
    }
  | { readonly action: "skip"; readonly line: string }
  | { readonly action: "keep"; readonly line: string; readonly residentVersion: string }
  | {
      readonly action: "refuse";
      readonly why: "content-unknown" | "same-version-target" | "above-build";
      readonly line: string;
    };

const short = (d: string) => d.slice(0, 12);

/** Rows 1 to 9 of the plan, in that order. Pure. */
export function decideApp(i: DecideInput): Decision {
  const local = readAppIdentity(i.local);
  const localDigest = contentDigest(i.local);
  const name = local.name;
  const seen = describeRows(i.rows);
  const unknown = (what: string): Decision => ({
    action: "refuse",
    why: "content-unknown",
    line: `refuse    content-unknown ${name}: ${what} (${seen}); the server's state is not one this tool understands: the owner`,
  });
  // 1
  if (i.resident === null && i.rows.length === 0)
    return {
      action: "publish",
      how: "new",
      line: `publish   new ${name} ${local.version} (${seen})`,
    };
  // 2 (I2): every later row needs exactly one installed row at the downloaded version
  if (i.resident === null) return unknown("no package to download, but the server lists rows");
  const residentVersion = readAppIdentity(i.resident).version;
  const [row, ...more] = i.rows;
  if (row === undefined) return unknown(`a package ${residentVersion} with no extension row`);
  if (more.length > 0) return unknown(`${i.rows.length} extension rows`);
  if (!row.isInstalled) return unknown("its one row is not installed");
  if (rowVersion(row) !== residentVersion)
    return unknown(`its row is ${rowVersion(row)}, the package is ${residentVersion}`);
  // 3
  let residentDigest: string;
  try {
    residentDigest = contentDigest(i.resident);
  } catch (err) {
    if (err instanceof ContentUnknownError) return unknown(err.message);
    throw err;
  }
  // 4
  if (residentDigest === localDigest)
    return {
      action: "skip",
      line: `skip      ${name} ${residentVersion}: same content, digest ${short(localDigest)} (${seen})`,
    };
  const cmp = compareAppVersions(residentVersion, local.version);
  // 5
  if (cmp < 0)
    return {
      action: "publish",
      how: "upgrade",
      line: `publish   upgrade ${name} ${residentVersion} -> ${local.version} (${seen})`,
    };
  const changed = `content changed in ${changedEntries(i.resident, i.local).join(", ")} (resident digest ${short(residentDigest)}, compiler ${compilerVersion(i.resident)}; local ${short(localDigest)}, compiler ${compilerVersion(i.local)})`;
  if (cmp === 0) {
    // 6
    if (i.role === "target" && i.installedDependent !== null)
      return {
        action: "refuse",
        why: "same-version-target",
        line: `refuse    same-version-target ${name} ${residentVersion}: ${changed}; its dependent ${i.installedDependent} is installed, and an in-place publish of a target under an installed dependent is not measured; bump the target's app.json version, or the owner (${seen})`,
      };
    // 7
    return {
      action: "publish",
      how: "in place",
      line: `publish   in place ${name} ${local.version}: ${changed} (${seen})`,
      changed,
    };
  }
  // 8
  if (i.mode === "setup" && i.role === "target" && i.gateDeploys && isInstrumented(i.resident))
    return {
      action: "keep",
      residentVersion,
      line: `kept      minted target ${name} ${residentVersion}: gates republish it (R605, ruling (a)) (${seen})`,
    };
  // 9
  const remedy =
    i.role === "target" && i.mode === "republish"
      ? `publish it at a minted version: --mint ${i.dir}`
      : i.role === "target"
        ? "a newer app.json version, or the owner"
        : "a newer app.json version, or the owner (R605: nothing measured clears the installed-version record)";
  return {
    action: "refuse",
    why: "above-build",
    line: `refuse    above-build ${name}: resident ${residentVersion} above ${local.version}; ${remedy} (${seen})`,
  };
}

/** LethAL Control: the row check (I2) first, then `controlAction` on raw sha256. */
export function decideControl(
  local: Buffer,
  resident: Buffer | null,
  rs: readonly ExtensionRow[],
): Decision {
  const pinned = { version: readAppIdentity(local).version, sha256: sha256Of(local) };
  const seen = describeRows(rs);
  if (resident !== null || rs.length > 0) {
    const v = resident === null ? undefined : readAppIdentity(resident).version;
    const [row, ...more] = rs;
    if (
      v === undefined ||
      row === undefined ||
      more.length > 0 ||
      !row.isInstalled ||
      rowVersion(row) !== v
    )
      return {
        action: "refuse",
        why: "content-unknown",
        line: `refuse    content-unknown LethAL Control (${seen}); the owner`,
      };
  }
  try {
    const a = controlAction(
      resident === null
        ? null
        : { version: readAppIdentity(resident).version, sha256: sha256Of(resident) },
      pinned,
    );
    return a === "already-pinned"
      ? { action: "skip", line: `already-pinned LethAL Control ${pinned.version} (${seen})` }
      : {
          action: "publish",
          how: resident === null ? "new" : "upgrade",
          line: `publish   LethAL Control ${pinned.version} (${seen})`,
        };
  } catch (err) {
    return {
      action: "refuse",
      why: "above-build",
      line: `refuse    LethAL Control: ${(err as Error).message} (${seen})`,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// decide everything, then act

/** Everything the decide and act passes do on a server: a fake counts it in tests. */
export interface ServerOps {
  /** `residentPackage`: `null` only on a 404, any other failure throws. */
  resident(publisher: string, name: string): Promise<Buffer | null>;
  rows(appId: string): Promise<ExtensionRow[]>;
  publish(fileName: string, bytes: Buffer): Promise<void>;
}

export function realOps(c: Conn): ServerOps {
  let ext: Promise<string> | undefined;
  return {
    resident: (publisher, name) => residentPackage(c, publisher, name),
    rows: async (appId) => {
      ext ??= extensionsApi(c);
      return rows(c, await ext, appId);
    },
    publish: (fileName, bytes) => publishBytes(c, fileName, bytes),
  };
}

export interface AppItem {
  readonly dir: string;
  readonly local: Buffer;
  readonly role: "target" | "dependent" | "control";
  readonly gateDeploys: boolean;
  /** A dependent's target dir (for F6's kept-target line). */
  readonly targetDir?: string;
}

export interface Decided {
  readonly item: AppItem;
  readonly decision: Decision;
}

function appIdOf(b: Buffer): string {
  return readAppIdentity(b).id;
}

/**
 * Decides every item against the server, printing each decision (with what the rows said).
 * `fixtures` is every fixture manifest: an installed app among them that depends on a target is
 * that target's installed dependent, in BOTH modes (F4), whether or not it is in the list.
 */
export async function decideAll(
  items: readonly AppItem[],
  ops: ServerOps,
  mode: Mode,
  fixtures: ReadonlyMap<string, AppManifest>,
  log: (s: string) => void,
): Promise<Decided[]> {
  const out: Decided[] = [];
  for (const item of items) {
    const id = readAppIdentity(item.local);
    const resident = await ops.resident(id.publisher, id.name);
    const rs = await ops.rows(id.id);
    let decision: Decision;
    if (item.role === "control") decision = decideControl(item.local, resident, rs);
    else {
      let installedDependent: string | null = null;
      if (item.role === "target") {
        const me = fixtures.get(item.dir);
        if (me === undefined) throw new Error(`unknown fixture ${JSON.stringify(item.dir)}`);
        for (const [dir, m] of [...fixtures].sort(([a], [b]) => a.localeCompare(b))) {
          if (dir === item.dir || m.id === undefined || !dependsOn(m, me)) continue;
          const drs = await ops.rows(m.id);
          log(`  dependent ${m.name} of ${id.name}: ${describeRows(drs)}`);
          if (installedDependent === null && drs.some((r) => r.isInstalled))
            installedDependent = m.name;
        }
      }
      decision = decideApp({
        dir: item.dir,
        local: item.local,
        resident,
        rows: rs,
        role: item.role,
        gateDeploys: item.gateDeploys,
        installedDependent,
        mode,
      });
    }
    log(`  ${decision.line}`);
    out.push({ item, decision });
  }
  return out;
}

export function refusals(decided: readonly Decided[]): Decided[] {
  return decided.filter((d) => d.decision.action === "refuse");
}

/**
 * Publishes every `publish` decision in order, reading each back: the version, the raw sha256 and
 * the digest must equal the local build's, and the app must show exactly one installed row at
 * that version. Stops at the first failure, naming the app. Refuses to start if anything was
 * refused (decide-all-then-act).
 */
export async function actAll(
  decided: readonly Decided[],
  ops: ServerOps,
  log: (s: string) => void,
): Promise<void> {
  if (refusals(decided).length > 0) throw new Error("unreachable: actAll after a refusal");
  for (const { item, decision } of decided) {
    if (decision.action !== "publish") continue;
    const id = readAppIdentity(item.local);
    try {
      await ops.publish(`${id.publisher}_${id.name}_${id.version}.app`, item.local);
    } catch (err) {
      throw new Error(`${(err as Error).message}${remedyFor(err, item, id.name, decided)}`);
    }
    const back = await ops.resident(id.publisher, id.name);
    const rs = await ops.rows(id.id);
    const v = back === null ? "nothing" : readAppIdentity(back).version;
    const rawOk = back !== null && sha256Of(back) === sha256Of(item.local);
    const digestOk = back !== null && contentDigest(back) === contentDigest(item.local);
    const [row, ...more] = rs;
    const rowOk =
      row !== undefined && more.length === 0 && row.isInstalled && rowVersion(row) === id.version;
    if (v !== id.version || !rawOk || !digestOk || !rowOk)
      throw new Error(
        `read-back of ${id.name} (${item.dir}) does not match the local build: the server holds ${v}${back === null ? "" : ` sha256 ${sha256Of(back)}`}, the local build is ${id.version} sha256 ${sha256Of(item.local)} (${describeRows(rs)}); stopped`,
      );
    const detail = decision.changed !== undefined ? `: ${decision.changed}` : "";
    log(
      `  published ${decision.how} ${id.name} ${id.version}${detail}; read back: raw sha256 ${sha256Of(item.local)} = local, digest ${short(contentDigest(item.local))}, ${describeRows(rs)}`,
    );
  }
}

/** F6: the two act-pass failures that have a known remedy. */
function remedyFor(err: unknown, item: AppItem, name: string, decided: readonly Decided[]): string {
  const msg = (err as Error).message;
  const held = parseVersionConflict(msg);
  if (held !== null)
    return `\n  ${name}: BC holds an installed-version record at ${held} (R605); publish a newer build: bc-republish.ts republish --mint ${item.dir}`;
  if (item.role === "dependent" && item.targetDir !== undefined) {
    const t = decided.find((d) => d.item.dir === item.targetDir);
    if (t !== undefined && t.decision.action === "keep") {
      const tname = readAppIdentity(t.item.local).name;
      return `\n  the target ${tname} is a kept minted build ${t.decision.residentVersion}; run the target's gate, or bc-republish.ts republish --mint ${item.targetDir}, then re-run setup`;
    }
  }
  return "";
}
