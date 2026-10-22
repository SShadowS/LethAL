// R586: run LethAL's OWN al-runner probes (R123 wire contract, R7/R220 canary) unchanged against
// al-runtime-rs behind `v2-shim.sh`, and print every fact. Measurement tool only.
// Usage: bun scripts/r586-probe/lethal-probes.ts <alrunner> <out dir>
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runAlRunnerCanary } from "../../packages/runner/src/al-runner-canary";
import {
  contractRefusals,
  contractSummary,
  runAlRunnerContractProbe,
} from "../../packages/runner/src/al-runner-contract";

const [bin, outArg] = process.argv.slice(2);
if (bin === undefined || outArg === undefined)
  throw new Error("usage: lethal-probes.ts <alrunner> <out>");
const out = resolve(outArg);
await mkdir(out, { recursive: true });
const shimLog = join(out, "lethal-probes.shim.tsv");
await writeFile(shimLog, "", "utf8");
const shim = join(out, "lethal-probes-shim.sh");
await writeFile(
  shim,
  `#!/usr/bin/env bash\nexport R586_ALRUNNER=${JSON.stringify(resolve(bin))} R586_SHIM_LOG=${JSON.stringify(shimLog)} ALRUNNER_CACHE=${JSON.stringify(process.env.ALRUNNER_CACHE ?? "/work/tools/al-runtime-rs/cache")}\nexec ${JSON.stringify(join(import.meta.dir, "v2-shim.sh"))} "$@"\n`,
  { mode: 0o755 },
);
const lines: string[] = [];
const contract = await runAlRunnerContractProbe(shim);
lines.push(contractSummary(contract));
for (const f of contract.facts)
  lines.push(
    `  ${f.fact}: ${f.verdict} | expected ${f.expected} | measured ${f.measured.slice(0, 400)}`,
  );
lines.push(`  refusals: ${JSON.stringify(contractRefusals(contract))}`);
const canary = await runAlRunnerCanary(shim);
lines.push(`canary: ${JSON.stringify(canary).slice(0, 2000)}`);
await writeFile(join(out, "lethal-probes.txt"), `${lines.join("\n")}\n`, "utf8");
console.log(lines.join("\n"));
