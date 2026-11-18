/**
 * PR-67: publish a given list of PREBUILT third-party apps (Continia's) to one bc server over the
 * dev endpoint, deciding each by CONTENT (`bc-app-content.ts`). Modeled on bc-linux-setup.ts's
 * `--with-continia` step (d2) and bc-republish.ts's lease handling: a coord lease taken in
 * `--lane`'s name, the token written to `--token-dir`.
 *
 *   bun scripts/bc-continia-publish.ts --server bcN --lane <lane> --token-dir <dir> --dir <packages dir> [--predict] [--ids <appId>...] -- <app file name>...
 *
 * The app files are named in dependency order. Each app's NavxManifest dependencies must be earlier
 * in the list, or already on the server at or above the MinVersion; anything else is refused by name
 * before any publish. DECIDE all, then ACT only if nothing was refused:
 *   skip      same content resident
 *   publish   absent (new), or a lower resident version (upgrade)
 *   refuse    a higher resident version, the same version with other content, a server state this
 *             tool does not understand, an app before its dependency, a missing or too-old dependency
 * `--predict` stops after deciding. Acting publishes in order and reads each back: version, raw
 * sha256 and content digest equal the file's, exactly one installed row. Nothing is ever uninstalled
 * or unpublished.
 *
 * `--ids <appId>...` is a READ-ONLY report of the installed rows of each id (one `rows` call per id,
 * never a list of all extensions: R433, that hung BC). With `--ids` and no app files nothing is
 * published.
 *
 * CREDENTIALS: as bc-republish.ts (`connFor`): read in-process, sent only as a Basic auth header.
 */
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { outOfUseDir } from "../packages/runner/itest/out-of-use.ts";
import { appInputsOfPackage } from "../packages/runner/src/digest-inputs.ts";
import { readAppIdentity } from "../packages/runner/src/published-test-app.ts";
import { textSearchApp, textSearchNote } from "../packages/runner/src/text-search-fields.ts";
import {
  type AppItem,
  type Decided,
  type Decision,
  SERVERS,
  type ServerName,
  type ServerOps,
  actAll,
  contentDigest,
  describeRows,
  realOps,
  refusals,
  rowVersion,
} from "./bc-app-content.ts";
import {
  continiaDependencyProblems,
  errText,
  heldLeaseDeps,
  realContiniaOps,
  versionBelow,
  withLease,
} from "./bc-linux-setup.ts";
import { connFor, leaseFor, refuseIfOutOfUse } from "./bc-republish.ts";

export interface Args {
  readonly server: ServerName;
  readonly lane: string;
  readonly tokenDir: string;
  readonly dir: string;
  readonly predict: boolean;
  readonly ids: string[];
  readonly files: string[];
  /** A coord lease the caller already holds on `server` (`heldLeaseDeps`): heartbeated, never taken or
   *  released, so a failure leaves the caller holding the server. */
  readonly heldLease?: string;
}

const USAGE =
  "usage: bun scripts/bc-continia-publish.ts --server bc1|bc2|bc3|bc4 --lane <lane> --token-dir <dir> --dir <packages dir> [--predict] [--held-lease <token>] [--ids <appId>...] -- <app file name>...";

export function parseArgs(argv: readonly string[]): Args {
  let server: string | undefined;
  let lane: string | undefined;
  let tokenDir: string | undefined;
  let dir: string | undefined;
  let predict = false;
  let heldLease: string | undefined;
  const ids: string[] = [];
  const files: string[] = [];
  const dd = argv.indexOf("--");
  const flags = dd < 0 ? argv : argv.slice(0, dd);
  if (dd >= 0) files.push(...argv.slice(dd + 1));
  for (let i = 0; i < flags.length; i++) {
    const a = flags[i];
    const value = (): string => {
      const v = flags[++i];
      if (v === undefined || v === "" || v.startsWith("-"))
        throw new Error(`${a} needs a value, got ${JSON.stringify(v)}\n${USAGE}`);
      return v;
    };
    if (a === "--server") server = value();
    else if (a === "--lane") lane = value();
    else if (a === "--token-dir") tokenDir = value();
    else if (a === "--dir") dir = value();
    else if (a === "--predict") predict = true;
    else if (a === "--held-lease") heldLease = value();
    else if (a === "--ids") {
      ids.push(value());
      while (flags[i + 1] !== undefined && !(flags[i + 1] as string).startsWith("-"))
        ids.push(flags[++i] as string);
    } else throw new Error(`unknown argument ${JSON.stringify(a)}\n${USAGE}`);
  }
  if (server === undefined || !(server in SERVERS))
    throw new Error(`--server is required\n${USAGE}`);
  if (lane === undefined)
    throw new Error(`--lane is required (the lease is taken in its name)\n${USAGE}`);
  if (tokenDir === undefined)
    throw new Error(`--token-dir is required (the lease token is written there)\n${USAGE}`);
  if (files.length > 0 && dir === undefined) throw new Error(`--dir is required\n${USAGE}`);
  if (files.length === 0 && ids.length === 0)
    throw new Error(`name app files after --, or --ids\n${USAGE}`);
  if (files.length === 0 && predict) throw new Error(`--predict needs app files\n${USAGE}`);
  for (const f of files)
    if (f !== basename(f) || f.startsWith("-"))
      throw new Error(`${JSON.stringify(f)} is not a plain file name\n${USAGE}`);
  return {
    server: server as ServerName,
    lane,
    tokenDir,
    dir: dir ?? "",
    predict,
    ids,
    files,
    ...(heldLease !== undefined ? { heldLease } : {}),
  };
}

/** What the run does on the server: a fake counts it in tests. */
export interface PublishOps extends ServerOps {
  /** Strict (R624): `null` only on a 404. */
  residentVersion(publisher: string, name: string): Promise<string | null>;
}

export function realPublishOps(c: Parameters<typeof realOps>[0]): PublishOps {
  return { ...realOps(c), residentVersion: realContiniaOps(c).residentVersion };
}

const short = (d: string) => d.slice(0, 12);

/**
 * One app's decision. Not `decideApp`: that orders versions with `compareAppVersions`, which
 * refuses a part above 65535, and Continia's builds carry revisions like 336834.
 */
export function decideThirdParty(
  local: Buffer,
  resident: Buffer | null,
  rs: Awaited<ReturnType<ServerOps["rows"]>>,
): Decision {
  const me = readAppIdentity(local);
  const seen = describeRows(rs);
  const unknown = (what: string): Decision => ({
    action: "refuse",
    why: "content-unknown",
    line: `refuse    content-unknown ${me.name}: ${what} (${seen}); the server's state is not one this tool understands: the owner`,
  });
  if (resident === null && rs.length === 0)
    return {
      action: "publish",
      how: "new",
      line: `publish   new ${me.name} ${me.version} (${seen})`,
    };
  if (resident === null) return unknown("no package to download, but the server lists rows");
  const have = readAppIdentity(resident).version;
  const [row, ...more] = rs;
  if (row === undefined) return unknown(`a package ${have} with no extension row`);
  if (more.length > 0) return unknown(`${rs.length} extension rows`);
  if (!row.isInstalled) return unknown("its one row is not installed");
  if (rowVersion(row) !== have)
    return unknown(`its row is ${rowVersion(row)}, the package is ${have}`);
  const lastDigest = contentDigest(local);
  if (have === me.version) {
    if (contentDigest(resident) === lastDigest)
      return {
        action: "skip",
        line: `skip      ${me.name} ${have}: same content, digest ${short(lastDigest)} (${seen})`,
      };
    return {
      action: "refuse",
      why: "content-unknown",
      line: `refuse    same-version-other-content ${me.name} ${have}: resident digest ${short(contentDigest(resident))}, file ${short(lastDigest)}; a third-party app is never replaced here (${seen})`,
    };
  }
  if (versionBelow(have, me.version))
    return {
      action: "publish",
      how: "upgrade",
      line: `publish   upgrade ${me.name} ${have} -> ${me.version} (${seen})`,
    };
  return {
    action: "refuse",
    why: "above-build",
    line: `refuse    above-build ${me.name}: resident ${have} above ${me.version} (${seen})`,
  };
}

/**
 * Order and dependency checks, by name. Each dependency must be listed EARLIER, or be on the server
 * at or above its MinVersion (`continiaDependencyProblems`, over the listed apps plus the server's
 * Microsoft and other resident apps).
 */
export async function dependencyRefusals(
  files: readonly { readonly file: string; readonly bytes: Buffer }[],
  ops: PublishOps,
): Promise<string[]> {
  const out: string[] = [];
  const listed = files.map((f) => ({ ...readAppIdentity(f.bytes), bytes: f.bytes }));
  const resident = new Map<string, string | null>();
  const pinned = new Map(listed.map((a) => [a.name, a.version]));
  for (const n of ["Application", "System"])
    resident.set(n, await ops.residentVersion("Microsoft", n));
  listed.forEach((a, i) => {
    for (const d of appInputsOfPackage(a.bytes).dependencies) {
      const j = listed.findIndex((x) => x.id.toLowerCase() === d.id || x.name === d.name);
      if (j >= i)
        out.push(
          `refuse    order ${a.name} (position ${i + 1}) depends on ${d.name}, which is ${j === i ? "itself" : `listed later (position ${j + 1})`}; name the files dependencies first`,
        );
    }
  });
  for (const a of listed) {
    for (const d of appInputsOfPackage(a.bytes).dependencies) {
      if (listed.some((x) => x.id.toLowerCase() === d.id || x.name === d.name)) continue;
      const v = await ops.residentVersion(d.publisher, d.name);
      if (d.publisher === "Microsoft") resident.set(d.name, v);
      else if (v !== null) pinned.set(d.name, v);
    }
  }
  for (const a of listed)
    for (const p of continiaDependencyProblems(a.bytes, resident, pinned))
      out.push(`refuse    depends ${p}`);
  return out;
}

export interface Deps {
  readonly ops: PublishOps;
  readonly read: (path: string) => Buffer;
  readonly log: (s: string) => void;
}

/** `--ids`: the installed rows per id, read only. One `rows` call per id; no list of extensions. */
export async function reportIds(ids: readonly string[], d: Deps): Promise<void> {
  for (const id of ids) d.log(`  ids       ${id}: ${describeRows(await d.ops.rows(id))}`);
}

/** Decide everything, refuse as a whole, then (unless `--predict`) publish and read back. */
export async function run(args: Args, d: Deps): Promise<void> {
  await reportIds(args.ids, d);
  if (args.files.length === 0) return;
  const files = args.files.map((f) => ({ file: f, bytes: d.read(join(args.dir, f)) }));
  const refused: string[] = await dependencyRefusals(files, d.ops);
  const decided: Decided[] = [];
  for (const { file, bytes } of files) {
    const id = readAppIdentity(bytes);
    const decision = decideThirdParty(
      bytes,
      await d.ops.resident(id.publisher, id.name),
      await d.ops.rows(id.id),
    );
    d.log(`  ${decision.line}`);
    // PR-128 (R1110): an app that would be installed and declares text-optimized fields needs SQL Server Full-Text Search,
    // which no call here can read; say so before the publish, not after its HTTP 422.
    if (decision.line.trimStart().startsWith("publish")) {
      const ts = textSearchApp(bytes);
      if (ts !== undefined) d.log(`  note      ${textSearchNote(ts)}`);
    }
    const item: AppItem = { dir: file, local: bytes, role: "target", gateDeploys: false };
    decided.push({ item, decision });
  }
  for (const r of refused) d.log(`  ${r}`);
  const count = refusals(decided).length + refused.length;
  if (count > 0) throw new Error(`${count} refusal(s), so NOTHING was published`);
  if (args.predict) {
    d.log("  predicted: nothing published");
    return;
  }
  await actAll(decided, d.ops, d.log);
}

async function main(): Promise<number> {
  try {
    const args = parseArgs(process.argv.slice(2));
    refuseIfOutOfUse(args.server, outOfUseDir(process.env), process.env);
    const c = connFor(args.server);
    const lease =
      args.heldLease !== undefined
        ? heldLeaseDeps(args.heldLease)
        : leaseFor(args.lane, args.tokenDir, "continia");
    await withLease(args.server, lease, () =>
      run(args, { ops: realPublishOps(c), read: (p) => readFileSync(p), log: console.log }),
    );
    console.log("ok");
    return 0;
  } catch (err) {
    console.error(`FAILED: ${errText(err)}`);
    return 1;
  }
}

if (import.meta.main) process.exit(await main());
