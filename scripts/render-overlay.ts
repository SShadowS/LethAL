#!/usr/bin/env bun
/**
 * Render a finished `SessionReport` as a source overlay: one self-contained HTML page showing, for
 * every measured line, whether changing it was NOTICED.
 *
 *   bun scripts/render-overlay.ts <report.json> <project-dir> [--out <file.html>] [--first-party]
 *
 * ── WHAT IT DRAWS, AND WHAT IT REFUSES TO DRAW ────────────────────────────────────────────────
 *
 * The obvious ask is "colour the lines that ran, and the lines that were tested". Half of that is
 * not knowable here and is deliberately NOT drawn.
 *
 * LethAL's coverage is PROCEDURE-level (object-level for extension objects). It does not know that
 * line 44 executed; it knows a test executed `Redeem`. Painting every line of a covered procedure
 * as "ran" would manufacture line coverage the run never measured — the exact overclaim this tool
 * exists to call out, reproduced in its own output. So:
 *
 *   - "RUN" is drawn at PROCEDURE granularity, as a rail beside the procedure, and the legend names
 *     that granularity.
 *   - "CHECKED" is drawn at SITE granularity, as a mark on each mutated line, because that is
 *     exactly what the run measured.
 *   - Everything else is drawn SILENT. No mark means "never measured", and the legend says so in
 *     those words.
 *
 * The rule that keeps it honest: **safety is only ever claimed by an explicit positive mark.** It is
 * never implied by absence, by a background wash, or by an aggregate. There is no green page.
 *
 * Two distinctions the page refuses to blur, because both are constantly confused:
 *
 *   - A survivor whose coverage is `exact` (a test provably executed the mutated procedure) is a
 *     different finding from one whose coverage is `object`. Measured on a real app: 19 exact
 *     against 88 object. Treating all of them as findings is how an agent writes ~87 pointless
 *     tests. Solid marks are for the proven ones and are meant to be rare.
 *   - `survived` and `no-coverage` differ in GEOMETRY, not just colour: survived is a solid mark
 *     inside a covered rail (tests were here and did not notice), no-coverage is a hatched rail over
 *     a whole procedure (nobody came here at all).
 *
 * ── WHY IT NEEDS THE SOURCE TREE ──────────────────────────────────────────────────────────────
 *
 * The report carries file, line and the mutated snippet — not whole files, and not procedure
 * extents. So this reads the project too, and that raises a staleness question the page must not
 * answer by guessing: a report describes the source AS MEASURED. If the file changed since the run,
 * painting line 44 anyway paints the wrong code confidently. Every site is therefore VERIFIED
 * against the file (does the recorded text still start at that line?) and a mismatch renders as an
 * explicit `stale` mark instead of being placed silently.
 *
 * Procedure spans are found by scanning for `procedure` / `trigger` declarations rather than by
 * parsing, which is an approximation and is stated on the page rather than hidden. It decides where
 * a rail starts and stops; it never decides a verdict.
 *
 * ── PRIVACY ───────────────────────────────────────────────────────────────────────────────────
 *
 * This artifact embeds WHOLE SOURCE FILES, so it is more sensitive than the report it is made from
 * (which carries only snippets, and which `scripts/redact-campaign-report.ts` guards). Every page
 * carries a "do not publish" banner unless `--first-party` says the target app is ours. The only
 * example that ships in this repository is the gift card demo.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Mutant {
  readonly mutantCode: string;
  readonly file: string;
  readonly line: number;
  readonly operatorName: string;
  readonly verdict: string;
  readonly procedureName?: string;
  readonly triggerName?: string;
  readonly originalText: string;
  readonly mutatedText: string;
  readonly coveringTests?: readonly string[];
  readonly coverageAttribution?: string;
  readonly guardObserved?: boolean;
  readonly killingTest?: string;
  readonly killingTestFailure?: string;
}

interface Report {
  readonly mutationScore: number | null;
  readonly counts: Record<string, number>;
  readonly validity: {
    readonly reliability: string;
    readonly scoreDescribes: string;
    readonly caveats: readonly string[];
    readonly baselineTests?: { readonly total: number; readonly failing: number };
  };
  readonly mutants: readonly Mutant[];
}

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const [reportPath, projectDir] = positional;
if (reportPath === undefined || projectDir === undefined) {
  throw new Error(
    "usage: bun scripts/render-overlay.ts <report.json> <project-dir> [--out <file.html>] [--first-party]",
  );
}
const outIndex = args.indexOf("--out");
const outPath = outIndex >= 0 ? args[outIndex + 1] : "overlay.html";
if (outPath === undefined) throw new Error("--out needs a path");
const firstParty = args.includes("--first-party");

const report = JSON.parse(readFileSync(reportPath, "utf8")) as Report;
if (!Array.isArray(report.mutants)) {
  throw new Error(`${reportPath} is not a SessionReport: no mutants array`);
}

/** Where a procedure or trigger starts, by declaration scan. See the module doc comment on why this
 *  is an approximation and why that is acceptable for a rail and not for a verdict. */
interface Span {
  readonly name: string;
  readonly startLine: number;
  endLine: number;
}

const DECL = /^\s*(?:local\s+|internal\s+)?(procedure|trigger)\s+"?([A-Za-z0-9_ .]+)"?/;

function spansOf(lines: readonly string[]): Span[] {
  const found: Span[] = [];
  lines.forEach((text, i) => {
    const m = DECL.exec(text);
    if (m !== null)
      found.push({ name: m[2]?.trim() ?? "?", startLine: i + 1, endLine: lines.length });
  });
  found.forEach((s, i) => {
    const next = found[i + 1];
    if (next !== undefined) s.endLine = next.startLine - 1;
  });
  return found;
}

/**
 * Does the file still hold what the run measured at this site?
 *
 * Two checks, strongest first. `startIndex`/`endIndex` are offsets into the source as measured, so
 * on an unchanged file the slice equals `originalText` exactly. When a report predates those fields,
 * fall back to "the recorded text appears on the recorded line" — CONTAINED, not prefixed, because
 * an expression-level mutant records a condition that sits inside its statement.
 */
function sourceStillMatches(
  source: string,
  lines: readonly string[],
  m: Mutant & { startIndex?: number; endIndex?: number },
): boolean {
  if (typeof m.startIndex === "number" && typeof m.endIndex === "number") {
    return source.slice(m.startIndex, m.endIndex) === m.originalText;
  }
  const first = (m.originalText.split(/\r?\n/)[0] ?? "").trim();
  if (first === "") return true;
  return (lines[m.line - 1] ?? "").includes(first);
}

type SiteState =
  | "killed"
  | "survived-proven"
  | "survived-unproven"
  | "no-coverage"
  | "other"
  | "stale";

function siteState(m: Mutant, stale: boolean): SiteState {
  if (stale) return "stale";
  if (m.verdict === "survived") {
    return m.coverageAttribution === "exact" ? "survived-proven" : "survived-unproven";
  }
  if (m.verdict === "no-coverage") return "no-coverage";
  if (m.verdict === "killed") return "killed";
  return "other";
}

const STATE_MEANING: Record<SiteState, string> = {
  killed: "A test failed when this line was changed. This line is checked.",
  "survived-proven":
    "A test provably executed this procedure and stayed green when this line was changed.",
  "survived-unproven":
    "Something in this object ran, and whether any test reached this line is unknown. May be no finding at all.",
  "no-coverage": "No test executed this procedure at all.",
  other: "Recorded without a verdict about the mutant. Excluded from the score.",
  stale: "The source no longer matches what was measured, so this site is not placed on a line.",
};

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Sites grouped by the file they were measured in. */
const byFile = new Map<string, Mutant[]>();
for (const m of report.mutants) {
  const key = m.file.replace(/\\/g, "/");
  const list = byFile.get(key) ?? [];
  list.push(m);
  byFile.set(key, list);
}

interface RenderedSite {
  readonly mutant: Mutant;
  readonly state: SiteState;
  readonly file: string;
}

const allSites: RenderedSite[] = [];
const fileSections: string[] = [];
let staleCount = 0;

for (const [file, mutants] of [...byFile.entries()].sort()) {
  const abs = join(projectDir, file);
  if (!existsSync(abs)) {
    // Loud, never a quiet skip: a file the report measured and the tree does not have is a fact the
    // reader needs, not a section to omit.
    fileSections.push(
      `<section class="file missing"><h2>${esc(file)}</h2><p class="warn">This file is in the report and NOT in ${esc(projectDir)}. Its ${mutants.length} site(s) are listed in the index and cannot be placed on source.</p></section>`,
    );
    for (const m of mutants) allSites.push({ mutant: m, state: siteState(m, true), file });
    staleCount += mutants.length;
    continue;
  }
  const lines = readFileSync(abs, "utf8").split(/\r?\n/);
  const spans = spansOf(lines);

  const sitesByLine = new Map<number, RenderedSite[]>();
  const source = readFileSync(abs, "utf8");
  for (const m of mutants) {
    // Byte-exact where the report gives offsets: `startIndex`/`endIndex` are into the source AS
    // MEASURED, so an unchanged file slices back to `originalText` character for character.
    //
    // The first version of this check compared the recorded text against the START of the line and
    // called five sites stale that were not: an expression-level mutant records `Amount <= 0`,
    // which sits INSIDE `if Amount <= 0 then` rather than at its start. A staleness alarm that
    // cries wolf is worse than none, because the whole point of the mark is that a reader can
    // trust the unmarked lines.
    const stale = !sourceStillMatches(source, lines, m);
    if (stale) staleCount += 1;
    const site: RenderedSite = { mutant: m, state: siteState(m, stale), file };
    allSites.push(site);
    const at = sitesByLine.get(m.line) ?? [];
    at.push(site);
    sitesByLine.set(m.line, at);
  }

  /** A rail claims only what the mutants inside it measured. A span with no mutants gets NO rail and
   *  is labelled "not measured" — which is not the same as "not covered", and the difference is the
   *  reason both words appear on the page. */
  const railFor = (span: Span): { cls: string; label: string } => {
    const inside = mutants.filter((m) => m.line >= span.startLine && m.line <= span.endLine);
    if (inside.length === 0) return { cls: "rail-none", label: "0 sites, not measured" };
    if (inside.every((m) => m.verdict === "no-coverage")) {
      return { cls: "rail-uncovered", label: `${inside.length} site(s), no test executed this` };
    }
    const exact = inside.some((m) => m.coverageAttribution === "exact");
    return {
      cls: "rail-covered",
      label: exact
        ? `${inside.length} site(s), tests executed this procedure`
        : `${inside.length} site(s), object-level coverage only`,
    };
  };

  const rows: string[] = [];
  lines.forEach((text, i) => {
    const lineNo = i + 1;
    const span = spans.find((s) => lineNo >= s.startLine && lineNo <= s.endLine);
    const rail = span === undefined ? { cls: "rail-none", label: "" } : railFor(span);
    const here = sitesByLine.get(lineNo) ?? [];
    const loudest =
      here.find((s) => s.state === "survived-proven") ??
      here.find((s) => s.state === "survived-unproven") ??
      here.find((s) => s.state === "no-coverage") ??
      here[0];
    const mark =
      loudest === undefined
        ? '<span class="mark none"></span>'
        : `<span class="mark ${loudest.state}" title="${esc(STATE_MEANING[loudest.state])}"></span>`;
    const tint = loudest?.state === "survived-proven" ? " tint" : "";
    const detail =
      here.length === 0
        ? ""
        : `<details class="detail"><summary>${here.length} mutant(s) here</summary>${here
            .map((s) => siteCard(s))
            .join("")}</details>`;
    rows.push(
      `<div class="row${tint}"><span class="rail ${rail.cls}" title="${esc(rail.label)}"></span>${mark}<span class="ln">${lineNo}</span><code>${esc(text) || "&nbsp;"}</code>${detail}</div>`,
    );
  });

  const counted = mutants.length;
  fileSections.push(
    `<section class="file"><h2>${esc(file)} <span class="chip">${counted} measured site(s)</span></h2><div class="code">${rows.join("")}</div></section>`,
  );
}

function siteCard(s: RenderedSite): string {
  const m = s.mutant;
  const where =
    m.procedureName !== undefined && m.procedureName !== ""
      ? m.procedureName
      : (m.triggerName ?? "(trigger)");
  const tests = (m.coveringTests ?? []).map((t) => `<li>${esc(t)}</li>`).join("");
  return `<div class="card ${s.state}">
  <div class="cardhead"><span class="mark ${s.state}" aria-hidden="true"></span><b>${esc(m.operatorName)}</b> <span class="verdict">${esc(m.verdict)}</span> <span class="chip">${esc(where)}</span></div>
  <p class="meaning">${esc(STATE_MEANING[s.state])}</p>
  <div class="diff"><div class="was"><span>was</span><code>${esc(m.originalText)}</code></div><div class="now"><span>became</span><code>${esc(m.mutatedText) || "<em>(deleted)</em>"}</code></div></div>
  <p class="badges"><span class="badge">attribution: ${esc(m.coverageAttribution ?? "n/a")}</span><span class="badge">executionProven: ${m.coverageAttribution === "exact"}</span><span class="badge">guardObserved: ${String(m.guardObserved ?? "not measured")}</span></p>
  ${m.killingTest !== undefined ? `<p class="killed-by">killed by <b>${esc(m.killingTest)}</b></p>` : ""}
  ${tests !== "" ? `<details><summary>${(m.coveringTests ?? []).length} covering test(s)</summary><ul>${tests}</ul></details>` : ""}
</div>`;
}

const proven = allSites.filter((s) => s.state === "survived-proven");
const unproven = allSites.filter((s) => s.state === "survived-unproven");
const uncovered = allSites.filter((s) => s.state === "no-coverage");
const other = allSites.filter((s) => s.state === "other" || s.state === "stale");

const indexItem = (s: RenderedSite): string =>
  `<li><code>${esc(s.file)}:${s.mutant.line}</code> <span class="op">${esc(s.mutant.operatorName)}</span></li>`;

const score = report.mutationScore === null ? "n/a" : `${(report.mutationScore * 100).toFixed(1)}%`;
const caveats = report.validity.caveats
  .map((c) => `<span class="badge warnbadge">${esc(c)}</span>`)
  .join("");
const baseline = report.validity.baselineTests;

/** The page is named after the app it describes: `examples/gift-card` becomes "Gift Card Overlay",
 *  so a reader with several of these open can tell them apart by the tab alone. */
const projectName = (
  projectDir
    .split(/[/\\]+/)
    .filter((p) => p !== "")
    .pop() ?? ""
)
  .replace(/[-_]+/g, " ")
  .split(" ")
  .filter((w) => w !== "")
  .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
  .join(" ");

const html = `<title>${esc(projectName === "" ? "Mutation" : projectName)} Overlay</title>
<style>
:root{--bg:#f7f8f9;--fg:#171b1f;--dim:#657079;--line:#dfe4e8;--card:#fff;--killed:#2b8a7e;--proven:#c0392b;--unproven:#c0392b;--uncov:#7a5ea8;--tint:#fdf0ee;--railc:#8fa3b0;--warn:#8a6d00;--warnbg:#fff8e1}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#16181a;--fg:#e8e6e3;--dim:#9b978f;--line:#2c2f33;--card:#1d2023;--killed:#4fc3b0;--proven:#ff6b5a;--unproven:#ff6b5a;--uncov:#b08fe0;--tint:#2a1e1d;--railc:#5b6a75;--warn:#e0c060;--warnbg:#2a2417}}
:root[data-theme="dark"]{--bg:#16181a;--fg:#e8e6e3;--dim:#9b978f;--line:#2c2f33;--card:#1d2023;--killed:#4fc3b0;--proven:#ff6b5a;--unproven:#ff6b5a;--uncov:#b08fe0;--tint:#2a1e1d;--railc:#5b6a75;--warn:#e0c060;--warnbg:#2a2417}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:28px 20px 80px}
h1{font-size:1.5rem;margin:0 0 4px}
h2{font-size:1rem;margin:28px 0 8px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.sub{color:var(--dim);margin:0 0 20px}
.banner{background:var(--warnbg);color:var(--warn);border:1px solid currentColor;border-radius:8px;padding:10px 14px;margin:0 0 20px;font-size:.9rem}
.summary{display:flex;flex-wrap:wrap;gap:18px;align-items:baseline;border:1px solid var(--line);border-radius:10px;padding:14px 16px;background:var(--card)}
.score{font-size:2.4rem;font-weight:600;letter-spacing:-.02em;font-variant-numeric:tabular-nums;line-height:1.05}
.counts span{margin-right:14px;color:var(--dim);font-variant-numeric:tabular-nums}
.counts b{color:var(--fg)}
.badge{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:1px 9px;margin:2px 4px 2px 0;font-size:.78rem;color:var(--dim)}
.warnbadge{color:var(--warn);border-color:currentColor}
.legend{margin:22px 0;border:1px solid var(--line);border-radius:10px;padding:14px 16px;background:var(--card)}
.legend p{margin:0 0 10px}
.legend ul{margin:0;padding-left:0;list-style:none;display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:6px}
.legend li{display:flex;align-items:center;gap:9px;color:var(--dim);font-size:.9rem}
.no-signal{font-weight:600;color:var(--fg)}
.mark{width:11px;height:11px;flex:0 0 11px;display:inline-block;border-radius:50%}
.mark.none{background:none}
.mark.killed{background:var(--killed)}
.mark.survived-proven{background:var(--proven);border-radius:2px;transform:rotate(45deg)}
.mark.survived-unproven{background:none;border:2px solid var(--unproven);border-radius:2px;transform:rotate(45deg)}
.mark.no-coverage{background:none;border:2px solid var(--uncov);border-radius:0}
.mark.other,.mark.stale{background:var(--dim);border-radius:0;height:3px}
.rail{width:5px;flex:0 0 5px;align-self:stretch;margin-right:8px}
.rail-covered{background:var(--railc)}
.rail-uncovered{background:repeating-linear-gradient(45deg,var(--uncov) 0 3px,transparent 3px 6px)}
.rail-none{background:none}
.index{border:1px solid var(--line);border-radius:10px;padding:14px 16px;background:var(--card);margin:22px 0}
.index h3{margin:12px 0 4px;font-size:.95rem}
.index h3:first-child{margin-top:0}
.index ul{margin:0;padding-left:18px;color:var(--dim);font-size:.9rem}
.index code{color:var(--fg)}
.op{font-family:ui-monospace,monospace;font-size:.82rem}
.file{margin-top:34px}
.chip{font-size:.72rem;color:var(--dim);border:1px solid var(--line);border-radius:999px;padding:1px 8px;font-family:ui-sans-serif,system-ui,sans-serif;font-weight:400}
.code{border:1px solid var(--line);border-radius:10px;overflow-x:auto;background:var(--card);padding:8px 0}
.row{display:flex;align-items:center;gap:7px;padding:0 12px;min-height:1.5rem;flex-wrap:wrap}
.row.tint{background:var(--tint)}
.ln{color:var(--dim);font:12px/1.5 ui-monospace,monospace;width:2.4em;text-align:right;flex:0 0 auto}
.row code{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre;flex:1 1 auto}
.detail{flex:0 0 100%;margin:2px 0 8px 3.6em}
.detail>summary{cursor:pointer;color:var(--dim);font-size:.8rem}
.card{border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:8px 0;background:var(--bg)}
.cardhead{font-family:ui-monospace,monospace;font-size:.85rem;display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.verdict{color:var(--dim)}
.meaning{margin:6px 0;font-size:.9rem}
.diff{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:8px;margin:8px 0}
.diff>div{border:1px solid var(--line);border-radius:6px;padding:6px 8px;overflow-x:auto}
.diff span{display:block;font-size:.72rem;color:var(--dim);text-transform:uppercase;letter-spacing:.05em}
.diff code{font:12.5px/1.5 ui-monospace,monospace;white-space:pre-wrap}
.killed-by{font-size:.85rem;color:var(--dim);margin:6px 0 0}
.warn{color:var(--warn)}
summary:focus-visible,a:focus-visible{outline:2px solid var(--killed);outline-offset:2px;border-radius:3px}
.legend li span.mark,.legend li span.rail{flex:0 0 auto}
footer{margin-top:44px;color:var(--dim);font-size:.83rem;border-top:1px solid var(--line);padding-top:14px}
</style>
<div class="wrap">
<h1>Mutation overlay</h1>
<p class="sub">${esc(report.validity.scoreDescribes)}</p>
${firstParty ? "" : '<p class="banner"><b>Contains full application source.</b> This page embeds the files it measured, which is more than the report it was generated from carries. Do not publish it.</p>'}

<div class="summary">
  <div><div class="score">${score}</div><div class="badge">${esc(report.validity.reliability)}</div></div>
  <div class="counts">
    <span>killed <b>${report.counts.killed ?? 0}</b></span>
    <span>survived <b>${report.counts.survived ?? 0}</b></span>
    <span>no-coverage <b>${report.counts.noCoverage ?? 0}</b></span>
    ${baseline !== undefined ? `<span>baseline <b>${baseline.total - baseline.failing}/${baseline.total}</b> passing</span>` : ""}
    <div>${caveats}</div>
  </div>
</div>

<div class="legend">
  <p class="no-signal">No mark means LethAL never measured that line. Nothing on this page means "this line is fine".</p>
  <ul>
    <li><span class="mark killed"></span> checked: a test failed when this line changed</li>
    <li><span class="mark survived-proven"></span> survived, and a test provably ran this procedure</li>
    <li><span class="mark survived-unproven"></span> survived, but only object-level coverage: may be no finding</li>
    <li><span class="mark no-coverage"></span> no test executed this procedure</li>
    <li><span class="rail rail-covered" style="height:11px"></span> rail: tests executed this procedure (PROCEDURE level, not line level)</li>
    <li><span class="rail rail-uncovered" style="height:11px"></span> rail: measured, and nothing executed it</li>
  </ul>
</div>

<div class="index">
  <h3>${proven.length} survivor(s) with proven execution</h3><ul>${proven.map(indexItem).join("") || "<li>none</li>"}</ul>
  <h3>${unproven.length} survivor(s) without proven execution</h3><ul>${unproven.map(indexItem).join("") || "<li>none</li>"}</ul>
  <h3>${uncovered.length} site(s) no test executed</h3><ul>${uncovered.map(indexItem).join("") || "<li>none</li>"}</ul>
  ${other.length > 0 ? `<h3>${other.length} site(s) not measured or stale</h3><ul>${other.map(indexItem).join("")}</ul>` : ""}
</div>

${fileSections.join("\n")}

<footer>
Generated by <code>scripts/render-overlay.ts</code> from <code>${esc(reportPath)}</code>.
Rails are placed by scanning for <code>procedure</code>/<code>trigger</code> declarations, which is an
approximation: it decides where a rail starts and stops, never what a verdict is.
Every site was checked against the file before being placed; ${staleCount} could not be
${staleCount === 1 ? "matched and is" : "matched and are"} marked stale rather than drawn on a line.
</footer>
</div>
`;

writeFileSync(outPath, html, "utf8");
const staleNote = staleCount > 0 ? ` (${staleCount} stale)` : "";
console.log(
  `render-overlay: ${allSites.length} site(s) across ${byFile.size} file(s) -> ${outPath}${staleNote}`,
);
