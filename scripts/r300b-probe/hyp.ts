// R-300b: the hypotheses, computed from the probe source, and the classification of raw outputs.
//   bun scripts/r300b-probe/hyp.ts predict    -> per object, per path, each hypothesis's marker lines
//   bun scripts/r300b-probe/hyp.ts classify   -> reads out/ and says which hypothesis each output fits
// Offline only. Reads no config and no credential.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { initParser, parseAL, wrapRoot } from "../../packages/engine/src/index";
import { parseCobertura } from "../../packages/runner/src/al-runner-coverage";
import { AppMethodIndex } from "../../packages/runner/src/app-package";
import { fileLineMapEntries, objectIdentityOf } from "../../packages/runner/src/line-map";

const HERE = import.meta.dir;
const SRC = join(HERE, "target/src");
const OUT = join(HERE, "out");

type Kind = "active" | "inactive" | "directive";
interface Obj {
  id: number;
  file: string;
  header: number;
  close: number;
  hitName: string;
  hit: [number, number];
  miss?: [number, number];
  markers: number[];
  wrapped: boolean;
}
/** BC = object-relative (fenced line map); FILE = file-relative (al-runner). */
type Path = "BC" | "FILE";
interface Prediction {
  /** hypothesis class (identical predictions merged, e.g. "H1a=H1b") -> mapping of a file line */
  classes: Map<string, (line: number) => number>;
}

// Only the two condition forms this probe uses. Anything else is refused, never guessed.
function evalCond(c: string): boolean {
  const t = c.trim();
  if (t === "PROBESYM") return true;
  if (t === "not PROBESYM") return false;
  throw new Error(`unsupported #if condition: ${t}`);
}

function classify(lines: string[]): Kind[] {
  const out: Kind[] = [];
  const stack: { active: boolean; taken: boolean; parent: boolean }[] = [];
  const live = () => stack.every((s) => s.active);
  for (const l of lines) {
    const m = /^\s*#(if|elif|else|endif)\b(.*)$/.exec(l);
    if (m === null) {
      out.push(live() ? "active" : "inactive");
      continue;
    }
    out.push("directive");
    const [, d, rest] = m;
    const top = stack[stack.length - 1];
    if (d === "if") {
      const v = evalCond(rest ?? "");
      stack.push({ active: v, taken: v, parent: live() });
    } else if (top === undefined) throw new Error(`#${d} without #if`);
    else if (d === "elif") {
      const v = !top.taken && evalCond(rest ?? "");
      top.active = v;
      top.taken ||= v;
    } else if (d === "else") {
      top.active = !top.taken;
      top.taken = true;
    } else stack.pop();
  }
  if (stack.length !== 0) throw new Error("unclosed #if");
  return out;
}

const FILES = readdirSync(SRC).filter((f) => f.endsWith(".al")).sort();

async function objects(): Promise<{ objs: Obj[]; kinds: Map<string, Kind[]>; text: Map<string, string[]> }> {
  await initParser();
  const objs: Obj[] = [];
  const kinds = new Map<string, Kind[]>();
  const text = new Map<string, string[]>();
  for (const f of FILES) {
    const src = readFileSync(join(SRC, f), "utf8");
    const lines = src.split("\n");
    const k = classify(lines);
    kinds.set(f, k);
    text.set(f, lines);
    const at = (i: number) => (k[i] === "active" ? (lines[i] ?? "") : "");
    for (let i = 0; i < lines.length; i++) {
      const h = /^codeunit (\d+) /.exec(at(i));
      if (h === null) continue;
      let close = i + 1;
      while (close < lines.length && at(close) !== "}") close++;
      const procSpan = (re: RegExp): [number, number, string] | undefined => {
        for (let j = i; j < close; j++) {
          const p = re.exec(at(j));
          if (p === null) continue;
          let e = j;
          while (!/^\s+end;\s*$/.test(at(e))) e++;
          return [j + 1, e + 1, p[1] ?? ""];
        }
        return undefined;
      };
      const hit = procSpan(/^\s+procedure (\w*Hit)\(/);
      if (hit === undefined) throw new Error(`${f}: no Hit procedure`);
      const miss = procSpan(/^\s+procedure (\w*Miss)\(/);
      const markers: number[] = [];
      for (let j = hit[0] - 1; j < hit[1]; j++)
        if (/^\s+(X := \d+;|X \+= 1;|exit\(X\);)\s*$/.test(at(j))) markers.push(j + 1);
      if (markers.length !== 3) throw new Error(`${f}: expected 3 markers, found ${markers.length}`);
      objs.push({
        id: Number(h[1]),
        file: f,
        header: i + 1,
        close: close + 1,
        hitName: hit[2],
        hit: [hit[0], hit[1]],
        ...(miss ? { miss: [miss[0], miss[1]] as [number, number] } : {}),
        markers,
        wrapped: false,
      });
    }
  }
  // Wrapped = a directive between the previous object's close and the header, AND one between the
  // close and the next object's header (or the end of the file). A bare object after a wrapper is not.
  for (const o of objs) {
    const k = kinds.get(o.file) ?? [];
    const same = objs.filter((x) => x.file === o.file);
    const prev = Math.max(0, ...same.filter((x) => x.close < o.header).map((x) => x.close));
    const next = Math.min(k.length + 1, ...same.filter((x) => x.header > o.close).map((x) => x.header));
    const dir = (a: number, b: number) => k.slice(a, b - 1).includes("directive");
    o.wrapped = dir(prev, o.header) && dir(o.close, next);
  }
  return { objs, kinds, text };
}

/** Today's line-map base for this object, as `fileLineMapEntries` computes it (refusal ignored). */
function lineMapBase(file: string, header: number): number {
  const root = wrapRoot(parseAL(readFileSync(join(SRC, file), "utf8")));
  const e = fileLineMapEntries(root, objectIdentityOf, file).find(
    (x) => x.root.startPosition.row + 1 <= header && header <= x.root.endPosition.row + 1 && x.root.startPosition.row + 1 === header,
  );
  if (e === undefined) throw new Error(`${file}:${header}: no line-map entry`);
  return e.baseLine;
}

function predictions(o: Obj, all: Obj[], kinds: Map<string, Kind[]>, path: Path): Prediction {
  const k = kinds.get(o.file) ?? [];
  const count = (from: number, to: number, kind: Kind) =>
    k.slice(from, to - 1).filter((x) => x === kind).length; // lines from+1 .. to-1
  const prevEnd =
    path === "FILE"
      ? 0
      : Math.max(0, ...all.filter((x) => x.file === o.file && x.close < o.header).map((x) => x.close));
  const raw = new Map<string, (l: number) => number>();
  raw.set(path === "BC" ? "H1a" : "H1", (l) => l - prevEnd);
  if (path === "BC") {
    const base = lineMapBase(o.file, o.header);
    raw.set("H1b", (l) => l - base + 1);
  }
  raw.set("H2", (l) => l - prevEnd - count(prevEnd, l, "directive"));
  raw.set("H3", (l) => l - prevEnd - count(prevEnd, l, "directive") - count(prevEnd, l, "inactive"));
  // Merge hypotheses that predict identically for this object; refuse partial overlap.
  const classes = new Map<string, (l: number) => number>();
  const sig = new Map<string, string>();
  for (const [name, fn] of raw) {
    const s = o.markers.map(fn).join(",");
    const same = [...sig].find(([, v]) => v === s);
    if (same !== undefined) {
      const fnOld = classes.get(same[0]);
      classes.delete(same[0]);
      sig.delete(same[0]);
      const merged = `${same[0]}=${name}`;
      if (fnOld) classes.set(merged, fnOld);
      sig.set(merged, s);
      continue;
    }
    for (const [other, v] of sig) {
      const a = new Set(v.split(","));
      if (s.split(",").some((x) => a.has(x)))
        throw new Error(`obj ${o.id} ${path}: ${name} and ${other} share a marker line; not separable`);
    }
    classes.set(name, fn);
    sig.set(name, s);
  }
  return { classes };
}

/** Which hypothesis classes fit one output's hit lines. */
function fits(o: Obj, p: Prediction, hitLines: number[]): string[] {
  const got = new Set(hitLines);
  const ok: string[] = [];
  for (const [name, fn] of p.classes) {
    const lo = fn(o.hit[0]);
    const hi = fn(o.hit[1]);
    if (o.markers.every((m) => got.has(fn(m))) && hitLines.every((l) => l >= lo && l <= hi)) ok.push(name);
  }
  return ok;
}

const TEST_OF: Record<number, string> = { 91900: "W1", 91901: "C1", 91902: "E1", 91903: "P", 91904: "Q", 91905: "R" };
const CONTROLS = new Set([91901, 91903]);

const mode = process.argv[2];
const { objs, kinds, text } = await objects();

if (mode === "predict") {
  for (const o of objs) {
    console.log(
      `\n${TEST_OF[o.id]} codeunit ${o.id} (${o.file}) ${o.wrapped ? "WRAPPED" : (kinds.get(o.file) ?? []).slice(0, o.header).includes("directive") ? "bare, after a wrapper" : "bare"}${CONTROLS.has(o.id) ? " CONTROL" : ""}: header L${o.header}, close L${o.close}, ${o.hitName} L${o.hit[0]}-${o.hit[1]}${o.miss ? `, Miss L${o.miss[0]}-${o.miss[1]}` : ""}, marker file lines ${o.markers.join(",")}`,
    );
    for (const path of ["BC", "FILE"] as Path[]) {
      const p = predictions(o, objs, kinds, path);
      for (const [name, fn] of p.classes)
        console.log(
          `  ${path === "BC" ? "fenced (object-relative)" : "al-runner (file line)   "} ${name.padEnd(12)} markers ${o.markers.map(fn).join(",").padEnd(12)} ${o.hitName} span ${fn(o.hit[0])}-${fn(o.hit[1])}`,
        );
    }
  }
} else if (mode === "classify") {
  const files = existsSync(OUT) ? readdirSync(OUT) : [];
  const byId = new Map(objs.map((o) => [o.id, o]));
  const report = (label: string, o: Obj, path: Path, lines: number[], extra = "") => {
    const f = fits(o, predictions(o, objs, kinds, path), lines);
    const verdict = f.length === 1 ? f[0] : f.length === 0 ? "H4 (none fits)" : `AMBIGUOUS ${f.join("|")}`;
    console.log(`${label.padEnd(26)} ${TEST_OF[o.id]} ${String(o.id)} hit=[${lines.join(",")}] -> ${verdict}${extra}`);
  };
  // Fenced (in-test Code Coverage read): failure text "MEASURED obj=<id> rows=L<n>/<type>/<hits>/<text>|..."
  for (const f of files.filter((x) => /^bc-r\d+-fence\.json$/.test(x))) {
    const body = readFileSync(join(OUT, f), "utf8");
    for (const m of body.matchAll(/MEASURED obj=(\d+) rows=([^"\\]*)/g)) {
      const o = byId.get(Number(m[1]));
      if (o === undefined) continue;
      const rows = (m[2] ?? "").split("|").map((r) => /^L(\d+)\/([^/]*)\/(\d+)\/(.*)$/.exec(r)).filter((r) => r !== null);
      const hitCode = rows.filter((r) => Number(r[3]) > 0 && r[2] === "Code").map((r) => Number(r[1]));
      const other = rows.filter((r) => Number(r[3]) > 0 && r[2] !== "Code").map((r) => `${r[2]}@${r[1]}`);
      // BC's own copy of each hit line, against the file text under H1a: a direct witness.
      const lines = text.get(o.file) ?? [];
      const prevEnd = Math.max(0, ...objs.filter((x) => x.file === o.file && x.close < o.header).map((x) => x.close));
      const textOk = rows
        .filter((r) => Number(r[3]) > 0)
        .every((r) => (lines[Number(r[1]) + prevEnd - 1] ?? "").trim().startsWith((r[4] ?? "").trim()));
      report(`${f} fenced`, o, "BC", hitCode, ` other-hit=[${other.join(",")}] BC-text-matches-H1a=${textOk}`);
    }
  }
  // Hub: methodIds resolved through the compiled target's SymbolReference.json, as AppMethodIndex does.
  const appPath = join(OUT, "target.app");
  const index = existsSync(appPath) ? await AppMethodIndex.fromAppFile(appPath) : undefined;
  for (const f of files.filter((x) => /^bc-r\d+-hub-Reach\w+\.json$/.test(x))) {
    const reached = objs.find((o) => f.endsWith(`Reach${TEST_OF[o.id]}.json`));
    const payload = JSON.parse(readFileSync(join(OUT, f), "utf8")) as {
      coverage?: { coveredProcedures?: { objectType: number; objectId: number; methodId: number }[] }[];
    };
    const names: string[] = [];
    for (const e of payload.coverage ?? [])
      for (const p of e.coveredProcedures ?? [])
        if (p.objectId >= 91900 && p.objectId <= 91929)
          names.push(`${p.objectId}:${index?.lookup(p.objectType, p.objectId, p.methodId) ?? `#unresolved(${p.methodId})`}`);
    const mine = names.filter((n) => reached !== undefined && n.startsWith(`${reached.id}:`));
    const verdict =
      reached === undefined
        ? "?"
        : mine.length === 0
          ? "HUB-C (no entry for the reached object)"
          : mine.some((n) => n.includes("#unresolved"))
            ? "HUB-B (a method id does not resolve)"
            : mine.length === 1 && mine[0] === `${reached.id}:${reached.hitName}` && names.length === 1
              ? "HUB-A (exactly the compiled arm's reached procedure)"
              : "HUB-D (other)";
    console.log(`${f.padEnd(26)} [${names.join(", ")}] -> ${verdict}`);
  }
  // bcdev coverage "line": shape not pinned (the tool calls it unproven). Any {objectId, line-ish} rows are classified.
  for (const f of files.filter((x) => /^bc-r\d+-line-Reach\w+\.json$/.test(x))) {
    const rows: { id: number; line: number }[] = [];
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v !== null && typeof v === "object") {
        const r = v as Record<string, unknown>;
        const line = r.lineNo ?? r.line ?? r.lineNumber;
        if (typeof r.objectId === "number" && typeof line === "number" && (r.hits === undefined || Number(r.hits) > 0))
          rows.push({ id: r.objectId, line });
        Object.values(r).forEach(walk);
      }
    };
    walk(JSON.parse(readFileSync(join(OUT, f), "utf8")));
    const o = objs.find((x) => f.endsWith(`Reach${TEST_OF[x.id]}.json`));
    if (o === undefined) continue;
    const mine = rows.filter((r) => r.id === o.id).map((r) => r.line);
    if (rows.length === 0) console.log(`${f.padEnd(26)} unparsed: no {objectId, line} rows (raw kept)`);
    else report(`${f} bcdev-line`, o, "BC", [...new Set(mine)].sort((a, b) => a - b));
  }
  // al-runner one-shot Cobertura, one file per test.
  for (const f of files.filter((x) => /^ar-r\d+-oneshot-Reach\w+\.xml$/.test(x))) {
    const o = objs.find((x) => f.endsWith(`Reach${TEST_OF[x.id]}.xml`));
    if (o === undefined) continue;
    const hit = parseCobertura(readFileSync(join(OUT, f), "utf8"))
      .filter((l) => l.hits > 0 && l.file.replace(/\\/g, "/").endsWith(o.file))
      .map((l) => l.line);
    report(`${f} cobertura`, o, "FILE", [...new Set(hit)].sort((a, b) => a - b));
  }
  // al-runner --server perTestCoverage.
  for (const f of files.filter((x) => /^ar-r\d+-server\.json$/.test(x))) {
    const res = JSON.parse(readFileSync(join(OUT, f), "utf8")) as {
      perTestCoverage?: { test: string; coverage?: { file: string; statements?: { line?: number; hits?: number; scope?: string }[] }[] }[];
    };
    for (const o of objs) {
      const t = res.perTestCoverage?.find((x) => x.test.toLowerCase() === `codeunit91930.reach${TEST_OF[o.id]}`.toLowerCase());
      const st = (t?.coverage ?? [])
        .filter((c) => c.file.replace(/\\/g, "/").endsWith(o.file))
        .flatMap((c) => c.statements ?? [])
        .filter((s) => (s.hits ?? 0) > 0 && s.line !== undefined);
      const scopes = [...new Set(st.map((s) => s.scope ?? ""))];
      report(`${f} server`, o, "FILE", [...new Set(st.map((s) => s.line ?? 0))].sort((a, b) => a - b), ` scopes=[${scopes.join(",")}]`);
    }
  }
} else throw new Error("mode: predict | classify");
