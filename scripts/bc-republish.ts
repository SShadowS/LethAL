/**
 * R-604 (R599): replace fixture apps on a bc server with the CURRENT local fixture builds, even when
 * the server already holds the same or a higher version; move LethAL Control to master's pinned
 * build; fill a tests fixture's `.alpackages`. Every mode talks to the server only under a coord
 * lease taken in `--lane`'s name (R598: never a default lane), with the token written to
 * `--token-dir`.
 *
 *   bun scripts/bc-republish.ts republish  --server bcN --lane <lane> --token-dir <dir> [--mint <fixture>]... <fixture>...
 *   bun scripts/bc-republish.ts control    --server bcN --lane <lane> --token-dir <dir>
 *   bun scripts/bc-republish.ts alpackages --server bcN --lane <lane> --token-dir <dir> <tests fixture>...
 *
 * `republish`:
 *   1. compiles every app with alc. Microsoft symbols come from the server; a LethAL dependency in
 *      the plan is compiled against its new local build, one outside the plan against the server's
 *      resident package. `--mint` builds a copy whose app.json version is minted by LethAL's own
 *      `reserveAppVersion`, as a gate's deploy does;
 *   2. REFUSES, before anything is removed, when the server holds any planned app above the version
 *      about to be published. BC keeps an installed-version record after unpublish and refuses a
 *      lower publish (R605), so going ahead would leave the apps off the server;
 *   3. per app, dependents first: uninstall, then the automation API's bound
 *      `Microsoft.NAV.unpublish` action (the path R-389 measured on bc3), then checks the app is gone;
 *   4. per app, targets first: publishes over the dev endpoint, then reads the resident package back
 *      and requires its version AND its sha256 to equal the local build's. A publish failure or a
 *      read-back mismatch STOPS the run, and the error lists every app left off the server.
 * A fixture that depends on a listed app is ADDED to the plan, and the tool says so: BC cannot
 * unpublish an app another installed app depends on, and the dependent must come back afterwards.
 *
 * `control` publishes the pinned LethAL Control build (`CONTROL_APP`, checked against
 * `CONTROL_SHA256` in bc-linux-setup.ts) over the dev endpoint as an UPGRADE: it never removes
 * anything, so the control app is never absent. It refuses when the server holds a higher version,
 * or the same version with other contents, and reads back version and sha256 after publishing.
 *
 * `alpackages` fills each named fixture's gitignored `.alpackages` from the server's own packages
 * (System, its Microsoft dependencies, and the resident build of each LethAL dependency).
 *
 * CREDENTIALS. As in bc-linux-setup.ts: the login is read from /coord/secrets/bc-linux.env in this
 * process and leaves it only as a Basic auth header. It is never printed, logged or put on a
 * command line; errors name the key, never the value.
 */
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compareAppVersions, reserveAppVersion } from "../packages/runner/src/app-version.ts";
import { bcFetch } from "../packages/runner/src/bc-fetch.ts";
import { readAppIdentity } from "../packages/runner/src/published-test-app.ts";
import { defaultAlToolPaths } from "../packages/runner/src/publisher.ts";
import {
  type AppManifest,
  CONTROL_APP,
  CONTROL_SHA256,
  type Conn,
  HOST,
  type LeaseDeps,
  PUBLISH_PLAN,
  SERVERS,
  type ServerName,
  alcCompile,
  downloadSymbols,
  errText,
  kraken,
  manifest,
  publishBytes,
  readSecretFile,
  residentPackage,
  sha256Of,
  withLease,
} from "./bc-linux-setup.ts";

const REPO = join(import.meta.dir, "..");
const FIXTURES = join(REPO, "fixtures");
const COMPANY = "CRONUS International Ltd.";

// ---------------------------------------------------------------------------------------------
// pure parts

export interface Args {
  readonly mode: "republish" | "control" | "alpackages";
  readonly server: ServerName;
  readonly lane: string;
  readonly tokenDir: string;
  readonly apps: string[];
  /** Fixtures published at a freshly minted version (LethAL's `reserveAppVersion`), not app.json's. */
  readonly mint: string[];
}

const USAGE =
  "usage: bun scripts/bc-republish.ts republish  --server bc1|bc2|bc3 --lane <lane> --token-dir <dir> [--mint <fixture>]... <fixture>...\n" +
  "       bun scripts/bc-republish.ts control    --server bc1|bc2|bc3 --lane <lane> --token-dir <dir>\n" +
  "       bun scripts/bc-republish.ts alpackages --server bc1|bc2|bc3 --lane <lane> --token-dir <dir> <tests fixture>...";

export function parseArgs(argv: readonly string[]): Args {
  const [mode, ...rest] = argv;
  if (mode !== "republish" && mode !== "control" && mode !== "alpackages") throw new Error(USAGE);
  let server: string | undefined;
  let lane: string | undefined;
  let tokenDir: string | undefined;
  const apps: string[] = [];
  const mint: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    // A flag's value never starts with `-`: `--lane --mint a` must not take "--mint" as the lane.
    const value = (): string => {
      const v = rest[++i];
      if (v === undefined || v === "" || v.startsWith("-")) {
        throw new Error(`${a} needs a value, got ${JSON.stringify(v)}\n${USAGE}`);
      }
      return v;
    };
    if (a === "--server") server = value();
    else if (a === "--lane") lane = value();
    else if (a === "--token-dir") tokenDir = value();
    else if (a === "--mint") {
      const m = value();
      mint.push(m);
      apps.push(m);
    } else if (a === undefined || a.startsWith("-"))
      throw new Error(`unknown argument ${JSON.stringify(a)}\n${USAGE}`);
    else apps.push(a);
  }
  if (server !== "bc1" && server !== "bc2" && server !== "bc3")
    throw new Error(`--server is required\n${USAGE}`);
  // R598: the lease holder must be the caller's lane, never a default.
  if (lane === undefined)
    throw new Error(`--lane is required (the lease is taken in its name)\n${USAGE}`);
  if (tokenDir === undefined)
    throw new Error(`--token-dir is required (the lease token is written there)\n${USAGE}`);
  if (mode !== "republish" && mint.length > 0) throw new Error(`${mode} takes no --mint`);
  if (mode === "control" && apps.length > 0)
    throw new Error("control publishes the pinned LethAL Control build and takes no fixture");
  if (mode !== "control" && apps.length === 0)
    throw new Error(`name at least one fixture directory\n${USAGE}`);
  return { mode, server, lane, tokenDir, apps, mint };
}

export interface Plan {
  /** Fixture dirs added because they depend on a requested app. */
  readonly added: readonly string[];
  /** Targets before the apps that depend on them. */
  readonly publish: readonly string[];
  /** Dependents before their targets: `publish` reversed. */
  readonly unpublish: readonly string[];
}

function dependsOn(app: AppManifest, target: AppManifest): boolean {
  return (app.dependencies ?? []).some((d) =>
    d.id !== undefined && target.id !== undefined
      ? d.id.toLowerCase() === target.id.toLowerCase()
      : d.name === target.name && d.publisher === target.publisher,
  );
}

/**
 * Closes `requested` over every fixture in `all` that depends on a member (repeatedly), then
 * orders it so each app follows the apps it depends on. Ties keep requested order, then added
 * order. Refuses an unknown fixture and a dependency cycle.
 */
export function republishPlan(
  requested: readonly string[],
  all: ReadonlyMap<string, AppManifest>,
): Plan {
  for (const r of requested)
    if (!all.has(r)) throw new Error(`unknown fixture ${JSON.stringify(r)}`);
  const set = [...new Set(requested)];
  const added: string[] = [];
  for (let grew = true; grew; ) {
    grew = false;
    for (const [dir, m] of [...all].sort(([a], [b]) => a.localeCompare(b))) {
      if (set.includes(dir)) continue;
      if (set.some((s) => dependsOn(m, all.get(s) as AppManifest))) {
        set.push(dir);
        added.push(dir);
        grew = true;
      }
    }
  }
  const publish: string[] = [];
  const left = [...set];
  while (left.length > 0) {
    const i = left.findIndex((d) =>
      left.every(
        (o) => o === d || !dependsOn(all.get(d) as AppManifest, all.get(o) as AppManifest),
      ),
    );
    if (i < 0) throw new Error(`dependency cycle among ${left.join(", ")}`);
    publish.push(...left.splice(i, 1));
  }
  return { added, publish, unpublish: [...publish].reverse() };
}

export interface PrePublishCheck {
  readonly dir: string;
  /** The version this run would publish. */
  readonly publishVersion: string;
  /** Every version the server lists for the app (the automation API's extension rows). */
  readonly resident: readonly string[];
  readonly minted: boolean;
}

/**
 * The refusal the run must give BEFORE it removes anything, or null. BC refuses a publish below
 * the installed-version record an unpublish leaves (R605), so an app resident above the version
 * about to be published would end up OFF the server.
 */
export function downgradeRefusal(checks: readonly PrePublishCheck[]): string | null {
  const bad = checks.flatMap((c) => {
    const above = c.resident.filter((r) => compareAppVersions(r, c.publishVersion) > 0);
    if (above.length === 0) return [];
    const fix = c.minted
      ? "the minted version is still below it"
      : `publish it at a minted version instead (--mint ${c.dir})`;
    return [`${c.dir}: the server holds ${above.join(", ")}, above ${c.publishVersion}; ${fix}`];
  });
  return bad.length === 0
    ? null
    : `refused before removing anything: BC would refuse the lower publish after the unpublish (R605), leaving the app off the server.\n  ${bad.join("\n  ")}`;
}

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

// ---------------------------------------------------------------------------------------------
// the server

function fixtureManifests(): Map<string, AppManifest> {
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

function connFor(server: ServerName): Conn {
  const login = readSecretFile();
  return {
    server,
    authorization: `Basic ${Buffer.from(`${login.user}:${login.password}`).toString("base64")}`,
  };
}

async function apiJson(c: Conn, url: string, method = "GET") {
  const res = await bcFetch(url, {
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

interface ExtensionRow {
  readonly packageId: string;
  readonly displayName: string;
  readonly isInstalled: boolean;
  readonly versionMajor: number;
  readonly versionMinor: number;
  readonly versionBuild: number;
  readonly versionRevision: number;
}

const rowVersion = (r: ExtensionRow) =>
  `${r.versionMajor}.${r.versionMinor}.${r.versionBuild}.${r.versionRevision}`;

async function extensionsApi(c: Conn): Promise<string> {
  const api = `${HOST}:${SERVERS[c.server].api}/BC/api`;
  const cs = await apiJson(c, `${api}/v2.0/companies?tenant=default`);
  if (!cs.ok) throw new Error(`${c.server}: companies: HTTP ${cs.status}`);
  const company = (cs.body.value as { id: string; name: string }[]).find((x) => x.name === COMPANY);
  if (company === undefined) throw new Error(`${c.server}: company ${COMPANY} not found`);
  return `${api}/microsoft/automation/v2.0/companies(${company.id})/extensions`;
}

async function rows(c: Conn, ext: string, appId: string): Promise<ExtensionRow[]> {
  const r = await apiJson(
    c,
    `${ext}?tenant=default&$filter=${encodeURIComponent(`id eq ${appId}`)}`,
  );
  if (!r.ok) throw new Error(`${c.server}: extensions filter: HTTP ${r.status}`);
  return r.body.value as ExtensionRow[];
}

/** Uninstall (when installed), then the bound unpublish action, for every row of the app's id. */
async function removeApp(
  c: Conn,
  ext: string,
  m: AppManifest,
  log: (s: string) => void,
): Promise<void> {
  if (m.id === undefined) throw new Error(`${m.name}: app.json has no id`);
  const found = await rows(c, ext, m.id);
  if (found.length === 0) log(`  absent      ${m.name}: nothing to remove`);
  for (const r of found) {
    const key = `${ext}(${r.packageId})`;
    if (r.isInstalled) {
      const u = await apiJson(c, `${key}/Microsoft.NAV.uninstall?tenant=default`, "POST");
      if (!u.ok)
        throw new Error(
          `${m.name} ${rowVersion(r)}: uninstall HTTP ${u.status}: ${u.text.slice(0, 500)}`,
        );
      log(`  uninstalled ${m.name} ${rowVersion(r)} (HTTP ${u.status})`);
    }
    const p = await apiJson(c, `${key}/Microsoft.NAV.unpublish?tenant=default`, "POST");
    if (!p.ok)
      throw new Error(
        `${m.name} ${rowVersion(r)}: unpublish HTTP ${p.status}: ${p.text.slice(0, 500)}`,
      );
    log(`  unpublished ${m.name} ${rowVersion(r)} (HTTP ${p.status})`);
  }
  const after = await rows(c, ext, m.id);
  if (after.length > 0)
    throw new Error(
      `${m.name}: still on the server after unpublish (${after.map(rowVersion).join(", ")})`,
    );
}

function leaseFor(lane: string, tokenDir: string, label: string): LeaseDeps {
  return {
    async take(server) {
      const token = (JSON.parse(await kraken(["lease", server, lane])) as { token?: unknown })
        .token;
      if (typeof token !== "string" || token === "")
        throw new Error(`kraken coord lease ${server}: no token`);
      return token;
    },
    recordToken(server, token) {
      mkdirSync(tokenDir, { recursive: true });
      writeFileSync(join(tokenDir, `lease-${server}-${label}.txt`), `${token}\n`, "utf8");
    },
    async heartbeat(server, token) {
      await kraken(["heartbeat", server, token]);
    },
    async release(server, token) {
      await kraken(["release", server, token]);
    },
  };
}

async function republish(args: Args): Promise<void> {
  const { server, apps, mint } = args;
  const all = fixtureManifests();
  const plan = republishPlan(apps, all);
  const log = (s: string) => console.log(s);
  log(`republish on ${server} (lane ${args.lane}): publish order ${plan.publish.join(", ")}`);
  if (plan.added.length > 0)
    log(`  added as dependents of a requested app: ${plan.added.join(", ")}`);
  const c = connFor(server);
  const tools = await defaultAlToolPaths();
  if (tools === undefined) throw new Error("no alc found under the AL Language extension");
  const build = join(REPO, ".kraken-local", "bc-republish", server);
  rmSync(build, { recursive: true, force: true });

  await withLease(server, leaseFor(args.lane, args.tokenDir, "republish"), async () => {
    // 1. compile everything before removing anything
    const built = new Map<string, Buffer>();
    for (const dir of plan.publish) {
      const m = all.get(dir) as AppManifest;
      const symbols = join(build, `${dir}-symbols`);
      mkdirSync(symbols, { recursive: true });
      await downloadSymbols(c, join(FIXTURES, dir), symbols);
      for (const d of (m.dependencies ?? []).filter((x) => x.publisher !== "Microsoft")) {
        const local = plan.publish.find(
          (p) => all.get(p)?.name === d.name && all.get(p)?.publisher === d.publisher,
        );
        const pkg =
          local !== undefined ? built.get(local) : await residentPackage(c, d.publisher, d.name);
        if (pkg === undefined || pkg === null)
          throw new Error(`${dir}: dependency ${d.name} is neither built nor on ${server}`);
        writeFileSync(join(symbols, `${d.publisher}_${d.name}.app`), pkg);
      }
      const out = join(build, `${dir}.app`);
      const defines = PUBLISH_PLAN.find((s) => s.target === dir)?.defines;
      let project = join(FIXTURES, dir);
      let version = m.version;
      if (mint.includes(dir)) {
        // A copy whose app.json carries a version minted the way a gate's deploy mints one, so it
        // outranks an installed-version record a gate run left (R605). Two targets can get the same
        // minted version within one 2 s tick; that is harmless, as they are different apps.
        version = reserveAppVersion({ sourceVersion: m.version, nowMs: Date.now() });
        project = join(build, `${dir}-src`);
        cpSync(join(FIXTURES, dir), project, { recursive: true });
        const raw = JSON.parse(readFileSync(join(project, "app.json"), "utf8")) as Record<
          string,
          unknown
        >;
        writeFileSync(
          join(project, "app.json"),
          `${JSON.stringify({ ...raw, version }, null, 2)}\n`,
        );
      }
      await alcCompile(tools.alcPath, project, symbols, out, defines);
      built.set(dir, readFileSync(out));
      log(
        `  compiled    ${m.name} ${version}${version !== m.version ? ` (minted; app.json ${m.version})` : ""} sha256 ${sha256Of(readFileSync(out))}`,
      );
    }
    // 2. refuse before removing anything when a publish would go below what the server holds
    const ext = await extensionsApi(c);
    const checks: PrePublishCheck[] = [];
    for (const dir of plan.publish) {
      const m = all.get(dir) as AppManifest;
      if (m.id === undefined) throw new Error(`${m.name}: app.json has no id`);
      checks.push({
        dir,
        publishVersion: readAppIdentity(built.get(dir) as Buffer).version,
        resident: (await rows(c, ext, m.id)).map(rowVersion),
        minted: mint.includes(dir),
      });
    }
    const refusal = downgradeRefusal(checks);
    if (refusal !== null) throw new Error(refusal);
    // 3. remove, dependents first
    for (const dir of plan.unpublish) await removeApp(c, ext, all.get(dir) as AppManifest, log);
    // 4. publish, targets first, and read back; stop at the first failure
    for (const [i, dir] of plan.publish.entries()) {
      const bytes = built.get(dir) as Buffer;
      const local = readAppIdentity(bytes);
      try {
        await publishBytes(c, `${local.publisher}_${local.name}_${local.version}.app`, bytes);
      } catch (err) {
        throw new Error(
          `${errText(err)}\n  removed and NOT republished: ${plan.publish.slice(i).join(", ")}`,
        );
      }
      const resident = await residentPackage(c, local.publisher, local.name);
      const version = resident === null ? "nothing" : readAppIdentity(resident).version;
      const sameHash = resident !== null && sha256Of(resident) === sha256Of(bytes);
      const pass = version === local.version && sameHash;
      log(
        `  ${pass ? "published  " : "MISMATCH   "} ${local.name}: resident ${version} (local ${local.version}); ` +
          `resident sha256 ${resident === null ? "-" : sha256Of(resident)} ${sameHash ? "=" : "!="} local`,
      );
      if (!pass) {
        const rest = plan.publish.slice(i + 1);
        throw new Error(
          `read-back of ${local.name} does not match the local build; stopped${rest.length > 0 ? `\n  removed and NOT republished: ${rest.join(", ")}` : ""}`,
        );
      }
    }
  });
}

async function control(args: Args): Promise<void> {
  const bytes = readFileSync(CONTROL_APP);
  const sha = sha256Of(bytes);
  if (sha !== CONTROL_SHA256)
    throw new Error(`${CONTROL_APP}: sha256 ${sha}, not the pinned ${CONTROL_SHA256}; refused`);
  const local = readAppIdentity(bytes);
  const c = connFor(args.server);
  await withLease(args.server, leaseFor(args.lane, args.tokenDir, "control"), async () => {
    const before = await residentPackage(c, local.publisher, local.name);
    const resident =
      before === null
        ? null
        : { version: readAppIdentity(before).version, sha256: sha256Of(before) };
    console.log(
      `control on ${args.server}: resident ${resident === null ? "nothing" : `${resident.version} sha256 ${resident.sha256}`}; pinned ${local.version} sha256 ${sha}`,
    );
    if (controlAction(resident, { version: local.version, sha256: sha }) === "already-pinned") {
      console.log("  already at the pinned build; nothing published");
      return;
    }
    await publishBytes(c, `${local.publisher}_${local.name}_${local.version}.app`, bytes);
    const after = await residentPackage(c, local.publisher, local.name);
    const v = after === null ? "nothing" : readAppIdentity(after).version;
    const s = after === null ? "-" : sha256Of(after);
    console.log(`  published: resident ${v} sha256 ${s} ${s === sha ? "=" : "!="} pinned`);
    if (v !== local.version || s !== sha)
      throw new Error("control read-back does not match the pinned build");
  });
}

async function alpackages(args: Args): Promise<void> {
  const all = fixtureManifests();
  const c = connFor(args.server);
  await withLease(args.server, leaseFor(args.lane, args.tokenDir, "alpackages"), async () => {
    for (const dir of args.apps) {
      const m = all.get(dir);
      if (m === undefined) throw new Error(`unknown fixture ${JSON.stringify(dir)}`);
      const dest = join(FIXTURES, dir, ".alpackages");
      rmSync(dest, { recursive: true, force: true });
      mkdirSync(dest, { recursive: true });
      await downloadSymbols(c, join(FIXTURES, dir), dest);
      const got = [
        "System",
        ...(m.dependencies ?? []).filter((d) => d.publisher === "Microsoft").map((d) => d.name),
      ];
      for (const d of (m.dependencies ?? []).filter((x) => x.publisher !== "Microsoft")) {
        const pkg = await residentPackage(c, d.publisher, d.name);
        if (pkg === null) throw new Error(`${args.server} holds no ${d.name}, which ${dir} needs`);
        const v = readAppIdentity(pkg).version;
        writeFileSync(join(dest, `${d.publisher}_${d.name}_${v}.app`), pkg);
        got.push(`${d.name} ${v}`);
      }
      console.log(`  ${dir}/.alpackages from ${args.server}: ${got.join(", ")}`);
    }
  });
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  try {
    if (args.mode === "alpackages") await alpackages(args);
    else if (args.mode === "control") await control(args);
    else await republish(args);
    console.log("ok");
    return 0;
  } catch (err) {
    console.error(`FAILED: ${errText(err)}`);
    return 1;
  }
}

if (import.meta.main) process.exit(await main());
