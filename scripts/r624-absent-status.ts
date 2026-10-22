/**
 * R-624 step 0 (plan I3): what HTTP status does a bc server's `dev/packages` give for an app it
 * cannot hold? Two reads, for names that cannot exist; prints ONLY each read's status. The login
 * is read inside this process from the secret file (as `bc-linux-setup.ts` does) and never printed.
 *
 *   bun scripts/r624-absent-status.ts bc3     (under a coord lease on that server)
 */
import { bcFetch } from "../packages/runner/src/bc-fetch.ts";
import { devPackagesUrl } from "../packages/runner/src/bcdev-backend.ts";
import { HOST, SERVERS, type ServerName } from "./bc-app-content.ts";
import { REAL_DEPS, readSecretFile } from "./bc-linux-setup.ts";

const server = process.argv[2];
if (server === undefined || !(server in SERVERS)) {
  console.error(`usage: bun scripts/r624-absent-status.ts <${Object.keys(SERVERS).join("|")}>`);
  process.exit(2);
}
const c = REAL_DEPS.connect(server as ServerName, readSecretFile());
for (const publisher of ["LethAL", "Microsoft"]) {
  const name = "R624 No Such App";
  const url = devPackagesUrl(
    {
      server: HOST,
      serverInstance: "BC",
      tenant: "default",
      port: SERVERS[server as ServerName].dev,
    },
    { publisher, name },
  );
  if (url === null) throw new Error("unreachable: devPackagesUrl refused a fixed URL");
  const res = await bcFetch(url, { headers: { authorization: c.authorization } });
  await res.arrayBuffer();
  console.log(`${c.server} dev/packages publisher=${publisher} name=${name}: HTTP ${res.status}`);
}
