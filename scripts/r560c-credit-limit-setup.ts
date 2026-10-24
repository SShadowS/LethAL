/**
 * R-560c: set up bc1 for the credit-limit example's re-freeze. `bc-demo-setup.ts`'s steps, for
 * `examples/credit-limit` on a gate server, under the caller's coord lease:
 *
 *   bun scripts/r560c-credit-limit-setup.ts --server bc1
 *
 * REFUSES (exit 2) unless `kraken coord holder bc1` names lane bugs. Then: the login, read in this
 * process (never printed); bc1's Microsoft symbol cache (filled or reused); the gitignored
 * `examples/credit-limit/lethal.config.bc1.json`; credit-limit and credit-limit-tests compiled and
 * decided by content (`bc-app-content.ts`), and published in Dev scope only if nothing is refused;
 * then `lethal doctor` on the config. A second run against an unchanged server publishes nothing.
 */
import { join } from "node:path";
import {
  type AppItem,
  type Conn,
  actAll,
  decideAll,
  realOps,
  refusals,
  residentPackage,
} from "./bc-app-content.ts";
import {
  CONTROL_APP,
  type PublishStep,
  bcDevMcpCommand,
  bcdevSection,
  describeLogin,
  doctor,
  errText,
  gitIgnores,
  pinnedControl,
  readSecretFile,
  realCompile,
  writeConfig,
} from "./bc-linux-setup.ts";
import { SYMBOL_CACHE_ROOT, fillSymbolCache } from "./bc-symbol-cache.ts";

const SERVER = "bc1";
const EXAMPLES = join(import.meta.dir, "..", "examples");
const CONFIG = join(EXAMPLES, "credit-limit", `lethal.config.${SERVER}.json`);
/** credit-limit's own idRanges hold 90297-90299 (`lethal.config.example.json`). */
const SELECTOR_IDS = { selectorId: 90299, controlId: 90298, tableId: 90297 };
const STEP: PublishStep = {
  target: "credit-limit",
  dependents: ["credit-limit-tests"],
  // `lethal run` deploys credit-limit itself as an instrumented, minted build: keep that one.
  gateDeploys: true,
};

function holderIsBugs(): void {
  const p = Bun.spawnSync(["kraken", "coord", "holder", SERVER]);
  const out = p.stdout.toString().trim();
  const h = p.exitCode === 0 ? (JSON.parse(out) as { lane?: unknown } | null) : null;
  if (h === null || h.lane !== "bugs")
    throw new Error(`${SERVER} is not held by lane bugs: ${out}`);
}

async function main(): Promise<number> {
  if (process.argv[2] !== "--server" || process.argv[3] !== SERVER) {
    console.error(`REFUSED: --server ${SERVER} is required`);
    return 2;
  }
  try {
    holderIsBugs();
  } catch (err) {
    console.error(`REFUSED: ${errText(err)}`);
    return 2;
  }
  if (!gitIgnores(CONFIG)) throw new Error(`${CONFIG} is not ignored by .gitignore`);
  const login = readSecretFile();
  console.log(`login: ${describeLogin(login)}`);
  const c: Conn = {
    server: SERVER,
    authorization: `Basic ${Buffer.from(`${login.user}:${login.password}`).toString("base64")}`,
  };
  const symbols = (
    await fillSymbolCache({
      root: SYMBOL_CACHE_ROOT,
      server: SERVER,
      names: ["System"],
      download: (name) => residentPackage(c, "Microsoft", name),
    })
  ).dir;
  console.log(`symbols ${symbols}`);
  writeConfig(
    CONFIG,
    {
      selectorIds: SELECTOR_IDS,
      bcdev: bcdevSection(SERVER, login, {
        mcpCommand: bcDevMcpCommand(),
        controlSymbolPath: CONTROL_APP,
        packageCachePath: symbols,
      }),
    },
    gitIgnores,
  );
  console.log(`wrote ${CONFIG}`);
  const log: string[] = [];
  const items: AppItem[] = [
    { dir: "lethal-control", local: pinnedControl(), role: "control", gateDeploys: false },
    ...(await realCompile(c, STEP, symbols, log, EXAMPLES)),
  ];
  const ops = realOps(c);
  const say = (s: string) => {
    log.push(s);
    console.log(s);
  };
  const decided = await decideAll(items, ops, "setup", say);
  if (refusals(decided).length > 0) {
    console.log(`STOPPED: ${refusals(decided).length} app(s) refused; NOTHING was published`);
    return 1;
  }
  await actAll(decided, ops, say);
  const ok = await doctor(
    CONFIG,
    join(EXAMPLES, "credit-limit"),
    join(EXAMPLES, "credit-limit-tests"),
  );
  console.log(`doctor ${ok ? "ok" : "FAILED"}`);
  return ok ? 0 : 1;
}

if (import.meta.main) {
  process.exit(
    await main().catch((err: unknown) => {
      console.error(`failed: ${errText(err)}`);
      return 1;
    }),
  );
}
