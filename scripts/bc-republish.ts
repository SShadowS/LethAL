/**
 * R-604, R599: publish the CURRENT local fixture builds to a bc server, deciding each app by its
 * normalised CONTENT digest (`bc-app-content.ts`), not its version; move LethAL Control to
 * master's pinned build; fill a tests fixture's `.alpackages`. Every mode talks to the server only
 * under a coord lease taken in `--lane`'s name (R598: never a default lane), with the token
 * written to `--token-dir`.
 *
 *   bun scripts/bc-republish.ts republish  --server bcN --lane <lane> --token-dir <dir> [--predict] [--mint <fixture>]... <fixture>...
 *   bun scripts/bc-republish.ts control    --server bcN --lane <lane> --token-dir <dir>
 *   bun scripts/bc-republish.ts alpackages --server bcN --lane <lane> --token-dir <dir> <tests fixture>...
 *
 * `republish`:
 *   1. compiles every named app with alc. Microsoft symbols come from the server; a LethAL
 *      dependency that is also named is compiled against its new local build, one that is not
 *      against the server's resident package (whose rows are printed). `--mint` builds a copy
 *      whose app.json version is minted by LethAL's own `reserveAppVersion`, as a gate's deploy
 *      does. Each compile line prints the build's header id, which becomes its `packageId`;
 *   2. DECIDES every app (`decideApp`, mode `republish`) and prints each decision with its rows:
 *      same content skips; a lower resident version is an upgrade; the same version with other
 *      content is published IN PLACE, naming the entries that differ, except a target with an
 *      installed fixture dependent (any fixture, named or not), which is refused (not measured);
 *      a resident version above the build is refused, naming `--mint <fixture>` for a target;
 *   3. if anything was refused, publishes NOTHING and fails. `--predict` stops here;
 *   4. publishes each `publish` decision over the dev endpoint, in order, and reads it back: the
 *      version, the raw sha256 and the digest must equal the local build's, with exactly one
 *      installed row. Nothing is ever uninstalled or unpublished;
 *   5. prints the rows again, after.
 * Changed by R599 (they were): (1) an app whose content is unchanged is skipped (it was always
 * removed and re-published); (2) `--mint` is an upgrade with nothing removed (it removed first,
 * and a dependent was added to the plan and cycled); (3) the refusal before publishing is the
 * decision table (it was a version check over a removal plan).
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
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ServerOutOfUseError,
  outOfUseDir,
  outOfUseRefusal,
} from "../packages/runner/itest/out-of-use.ts";
import { reserveAppVersion } from "../packages/runner/src/app-version.ts";
import { readAppIdentity } from "../packages/runner/src/published-test-app.ts";
import { defaultAlToolPaths } from "../packages/runner/src/publisher.ts";
import {
  type AppItem,
  type AppManifest,
  type ServerOps,
  actAll,
  controlAction,
  decideAll,
  dependsOn,
  describeRows,
  fixtureManifests,
  packageStatus,
  realOps,
  refusals,
} from "./bc-app-content.ts";
import {
  CONTROL_APP,
  CONTROL_SHA256,
  type Conn,
  type LeaseDeps,
  PUBLISH_PLAN,
  type ServerName,
  alcCompile,
  compiledLine,
  downloadSymbols,
  errText,
  kraken,
  publishBytes,
  readSecretFile,
  residentPackage,
  sha256Of,
  withLease,
} from "./bc-linux-setup.ts";

// Moved down into bc-app-content.ts (R599); re-exported so the test's import line stays.
export { controlAction, packageStatus };

const REPO = join(import.meta.dir, "..");
const FIXTURES = join(REPO, "fixtures");

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
  /** R599: `republish` decides and prints every app, and publishes nothing. */
  readonly predict?: boolean;
}

const USAGE =
  "usage: bun scripts/bc-republish.ts republish  --server bc1|bc2|bc3 --lane <lane> --token-dir <dir> [--predict] [--mint <fixture>]... <fixture>...\n" +
  "       bun scripts/bc-republish.ts control    --server bc1|bc2|bc3 --lane <lane> --token-dir <dir>\n" +
  "       bun scripts/bc-republish.ts alpackages --server bc1|bc2|bc3 --lane <lane> --token-dir <dir> <tests fixture>...";

export function parseArgs(argv: readonly string[]): Args {
  const [mode, ...rest] = argv;
  if (mode !== "republish" && mode !== "control" && mode !== "alpackages") throw new Error(USAGE);
  let server: string | undefined;
  let lane: string | undefined;
  let tokenDir: string | undefined;
  let predict = false;
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
    else if (a === "--predict") predict = true;
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
  if (mode !== "republish" && predict) throw new Error(`${mode} takes no --predict`);
  if (mode === "control" && apps.length > 0)
    throw new Error("control publishes the pinned LethAL Control build and takes no fixture");
  if (mode !== "control" && apps.length === 0)
    throw new Error(`name at least one fixture directory\n${USAGE}`);
  return { mode, server, lane, tokenDir, apps, mint, ...(predict ? { predict } : {}) };
}

export interface Plan {
  /** Fixture dirs added because they depend on a requested app. */
  readonly added: readonly string[];
  /** Targets before the apps that depend on them. */
  readonly publish: readonly string[];
  /** Dependents before their targets: `publish` reversed. */
  readonly unpublish: readonly string[];
}

/**
 * Closes `requested` over every fixture in `all` that depends on a member (repeatedly), then
 * orders it so each app follows the apps it depends on. Ties keep requested order, then added
 * order. Refuses an unknown fixture and a dependency cycle.
 *
 * R599: `republish` uses only the ORDER of the requested apps (`publishOrder`); nothing is removed
 * any more, so a dependent no longer has to be added and cycled.
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

/** The requested apps alone, each after the requested apps it depends on. */
export function publishOrder(
  requested: readonly string[],
  all: ReadonlyMap<string, AppManifest>,
): string[] {
  return republishPlan(requested, all).publish.filter((d) => requested.includes(d));
}

/**
 * A fixture is a target when it is a `PUBLISH_PLAN` target or any fixture depends on it (row 6 then
 * looks for its dependents, and a refusal above its build names `--mint`; review M4: sandbox-probes
 * has no dependent but is a target).
 */
export function roleOf(dir: string, all: ReadonlyMap<string, AppManifest>): "target" | "dependent" {
  const me = all.get(dir);
  if (me === undefined) throw new Error(`unknown fixture ${JSON.stringify(dir)}`);
  if (PUBLISH_PLAN.some((s) => s.target === dir)) return "target";
  return [...all].some(([d, m]) => d !== dir && dependsOn(m, me)) ? "target" : "dependent";
}

// ---------------------------------------------------------------------------------------------
// the server

function connFor(server: ServerName): Conn {
  const login = readSecretFile();
  return {
    server,
    authorization: `Basic ${Buffer.from(`${login.user}:${login.password}`).toString("base64")}`,
  };
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

/** Each item's rows, and its installed fixture dependents' rows: the chain a live check reads. */
async function printRows(
  label: string,
  items: readonly AppItem[],
  ops: ServerOps,
  all: ReadonlyMap<string, AppManifest>,
  log: (s: string) => void,
): Promise<void> {
  for (const item of items) {
    const id = readAppIdentity(item.local);
    log(`  ${label.padEnd(9)} ${id.name}: ${describeRows(await ops.rows(id.id))}`);
    const me = all.get(item.dir);
    if (me === undefined) continue;
    for (const [dir, m] of [...all].sort(([a], [b]) => a.localeCompare(b))) {
      if (dir === item.dir || m.id === undefined || !dependsOn(m, me)) continue;
      log(`  ${label.padEnd(9)} ${m.name} (dependent): ${describeRows(await ops.rows(m.id))}`);
    }
  }
}

async function republish(args: Args): Promise<void> {
  const { server, apps, mint } = args;
  const all = fixtureManifests();
  const order = publishOrder(apps, all);
  const log = (s: string) => console.log(s);
  log(
    `republish on ${server} (lane ${args.lane})${args.predict === true ? " --predict" : ""}: order ${order.join(", ")}`,
  );
  const c = connFor(server);
  const tools = await defaultAlToolPaths();
  if (tools === undefined) throw new Error("no alc found under the AL Language extension");
  const build = join(REPO, ".kraken-local", "bc-republish", server);
  rmSync(build, { recursive: true, force: true });

  await withLease(server, leaseFor(args.lane, args.tokenDir, "republish"), async () => {
    const ops = realOps(c);
    // 1. compile everything before deciding anything
    const items: AppItem[] = [];
    for (const dir of order) {
      const m = all.get(dir) as AppManifest;
      const symbols = join(build, `${dir}-symbols`);
      mkdirSync(symbols, { recursive: true });
      await downloadSymbols(c, join(FIXTURES, dir), symbols);
      for (const d of (m.dependencies ?? []).filter((x) => x.publisher !== "Microsoft")) {
        const local = order.find(
          (p) => all.get(p)?.name === d.name && all.get(p)?.publisher === d.publisher,
        );
        const pkg =
          local !== undefined
            ? items.find((i) => i.dir === local)?.local
            : await residentPackage(c, d.publisher, d.name);
        if (pkg === undefined || pkg === null)
          throw new Error(`${dir}: dependency ${d.name} is neither built nor on ${server}`);
        if (local === undefined) {
          const rid = readAppIdentity(pkg);
          log(
            `  against   resident ${rid.name} ${rid.version}: ${describeRows(await ops.rows(rid.id))}`,
          );
        }
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
      const bytes = readFileSync(out);
      log(compiledLine(bytes, version !== m.version ? ` (minted; app.json ${m.version})` : ""));
      items.push({ dir, local: bytes, role: roleOf(dir, all), gateDeploys: false });
    }
    try {
      // 2. decide every app; 3. refuse before publishing anything
      const decided = await decideAll(items, ops, "republish", all, log);
      const refused = refusals(decided);
      if (refused.length > 0)
        throw new Error(
          `${refused.length} app(s) refused, so NOTHING was published:\n  ${refused.map((d) => d.decision.line).join("\n  ")}`,
        );
      if (args.predict === true) {
        log("  predicted: nothing published");
        return;
      }
      // 4. publish in order, reading each back
      await actAll(decided, ops, log);
    } finally {
      // 5. the rows after, whatever happened; a failed read here never replaces the run's own
      // refusal or read-back error (review M3)
      try {
        await printRows("after", items, ops, all, log);
      } catch (err) {
        log(`  after     the rows could not be read: ${errText(err)}`);
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

/**
 * R669: every mode leases and talks to the server, so a marked server is refused first, by name.
 * Only the clearing override (`LETHAL_OUT_OF_USE_CLEARING=<server>`) lets it through.
 */
export function refuseIfOutOfUse(
  server: ServerName,
  dir: string,
  env: Readonly<Record<string, string | undefined>>,
  log: (line: string) => void = console.log,
): void {
  const refusal = outOfUseRefusal(server, { dir, env, override: "clearing", log });
  if (refusal !== undefined) throw new ServerOutOfUseError(refusal);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  try {
    refuseIfOutOfUse(args.server, outOfUseDir(process.env), process.env);
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
