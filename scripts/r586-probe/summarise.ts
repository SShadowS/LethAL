// R586: one line per contract.sh / compile-probe.sh case: exit code, then each row's name, status,
// notRun and message (cut), plus the first stderr "error" line. Measurement tool only.
// Usage: bun scripts/r586-probe/summarise.ts <out dir>
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (dir === undefined) throw new Error("usage: summarise.ts <out dir>");
const exits = new Map<string, string>();
for (const index of ["INDEX.tsv", "compile-INDEX.tsv"]) {
  let text = "";
  try {
    text = readFileSync(join(dir, index), "utf8");
  } catch {
    continue;
  }
  for (const line of text.split("\n")) {
    const [name, exit] = line.split("\t");
    if (name && exit) exits.set(index === "INDEX.tsv" ? name : `compile-${name}`, exit);
  }
}
for (const f of readdirSync(dir)
  .filter((x) => x.endsWith(".out"))
  .sort()) {
  const name = f.slice(0, -4);
  const out = readFileSync(join(dir, f), "utf8");
  const err = readFileSync(join(dir, `${name}.err`), "utf8");
  console.log(`== ${name} ${exits.get(name) ?? ""}`);
  try {
    const doc = JSON.parse(out) as { tests?: Record<string, unknown>[]; exitCode?: number };
    for (const t of doc.tests ?? [])
      console.log(
        `   ${t.name} ${t.status}${t.notRun ? " notRun" : ""} ${JSON.stringify(t.message ?? "").slice(0, 180)}`,
      );
  } catch {
    console.log("   (no JSON document on stdout)");
  }
  const e = err.split("\n").filter((l) => /^error|compile: error/.test(l));
  for (const l of e.slice(0, 3)) console.log(`   stderr: ${l.slice(0, 200)}`);
}
