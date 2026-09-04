"""Run 3 vs run 4: the R206 pre-commitment, checked line by line.

Reads both reports and both stores and prints PASS/FAIL against every number written in
docs/superpowers/specs/2026-09-03-r206-build-precommitment.md before run 4 started.

Keyed on mutant IDENTITY, never on `mutantCode`: codes restart per batch, and 83 of run 3's 741
mutants share a code with another batch's (M0020 names three different mutants). Keying on the
code compared the wrong pairs and silently reported 633 of 741 - caught by smoke-testing this
script against run 3 twice before run 4 existed.
"""
import json, sqlite3, collections, sys

# Both run directories are arguments: each must hold the run's `report.json` and `lethal.sqlite`.
# Passing the SAME directory twice is the smoke test that caught two key bugs in this script
# before run 4 existed (A vs A must report the table identical and the run-4-only fields absent).
if len(sys.argv) != 3:
    sys.exit(
        "usage: r206-run-compare.py <baselineRunDir> <newRunDir>\n"
        "  each directory must contain report.json and lethal.sqlite\n"
        "  pass the same directory twice to smoke-test the comparison itself"
    )
R3, R4 = sys.argv[1], sys.argv[2]

PRE = dict(warmKills=198, groupedCalls=896, killed=448, survived=237, mutants=741,
           survivorSeconds=2400.0)

# The two mutants run 3 measured closest to the server's 90 s headroom threshold, plus the third.
# Identified by SITE, because the mutant code alone is ambiguous across batches.
NEAR_CAP = (
    ("CDOVariantMatchCache.Codeunit.al", 70, "lethal.void-method-call", 158, 88.3),
    ("CDOVariantMatchCache.Codeunit.al", 71, "lethal.void-method-call", 158, 72.9),
    ("CDOTemplateVariantMgt.Codeunit.al", 913, "lethal.empty-block", 110, 36.1),
)


def load(p):
    with open(p + "/report.json", encoding="utf-8") as f:
        return json.load(f)


def base(path):
    return path.replace("\\", "/").split("/")[-1]


def key(m):
    # startIndex/endIndex are the source span, which separates the 5 pairs that share
    # file:line:operator:procedure:astHash (two mutants of one shape on one line).
    return (base(m["file"]), m["line"], m["operatorName"], m.get("procedureName"),
            m.get("astHash"), m.get("startIndex"), m.get("endIndex"))


def label(m):
    return f'{m["mutantCode"]}(b{m["batchIndex"]}) {base(m["file"])}:{m["line"]} {m["operatorName"]}'


def table(r):
    return {key(m): (m["verdict"], m.get("killingTest"), m.get("cause")) for m in r["mutants"]}


def positions_from_store(path):
    """Kill position per mutant IDENTITY from the store's own row order (run 3 predates the field)."""
    c = sqlite3.connect(path + "/lethal.sqlite")
    run = [x[0] for x in c.execute("select id from runs order by id")][-1]
    per = collections.defaultdict(list)
    for mr, out in c.execute(
        "select mutant_row_id, outcome from test_results where run_id=? and op_kind='many' "
        "and mutant_code is not null order by id", (run,)):
        per[mr].append(out)
    # The STORE has no start/end index (those are report-only); `identity_ordinal` is its own
    # disambiguator for two mutants sharing an identity, so the store side keys on that and the
    # report side is matched to it below.
    rows = {mid: (base(f), ln, op, proc, ah, v, ordi)
            for mid, f, ln, op, proc, ah, v, ordi in c.execute(
        "select id, file, line, operator_name, procedure_name, ast_hash, verdict, identity_ordinal "
        "from mutants where run_id=?", (run,))}
    out = {}
    for mr, outcomes in per.items():
        rec = rows.get(mr)
        if rec is None or rec[5] not in ("killed", "timeout-killed"):
            continue
        for i, o in enumerate(outcomes, 1):
            if o in ("fail", "timeout"):
                out[(rec[0], rec[1], rec[2], rec[3], rec[4], rec[6])] = i
                break
    return out


def per_method_ms(path):
    c = sqlite3.connect(path + "/lethal.sqlite")
    run = [x[0] for x in c.execute("select id from runs order by id")][-1]
    rows = [d for (d,) in c.execute(
        "select duration_ms from test_results where run_id=? and op_kind='many' "
        "and outcome in ('pass','fail')", (run,))]
    rows.sort()
    return rows


def survivor_seconds(r):
    return sum(m.get("durationMs", 0) for m in r["mutants"] if m["verdict"] == "survived") / 1000.0


def ok(cond):
    return "PASS" if cond else "**FAIL**"


r3, r4 = load(R3), load(R4)
t3, t4 = table(r3), table(r4)
lbl4 = {key(m): label(m) for m in r4["mutants"]}
fails = []

print("=" * 78)
print("R206 run 4 against its pre-commitment")
print("=" * 78)

# 1. The verdict table.
moved = {k: (t3.get(k), t4[k]) for k in t4 if t3.get(k) != t4[k]}
gone = [k for k in t3 if k not in t4]
print(f"\n1. VERDICT TABLE  {ok(not moved and not gone)}")
print(f"   run 3: {len(t3)} identities / {len(r3['mutants'])} mutants"
      f"   run 4: {len(t4)} / {len(r4['mutants'])}")
if len(t4) != PRE["mutants"]:
    print(f"   NOTE: {PRE['mutants'] - len(t4)} identity collisions (same file:line:operator)")
if gone:
    print(f"   MISSING from run 4: {[lbl4.get(k, k) for k in gone[:10]]}")
    fails.append("mutants missing")
if moved:
    fails.append(f"{len(moved)} verdicts moved")
    print(f"   {len(moved)} MOVED (run 3 -> run 4):")
    for k, (a, b) in sorted(moved.items(), key=lambda kv: lbl4.get(kv[0], str(kv[0])))[:40]:
        print(f"     {lbl4.get(k, k)}: {a} -> {b}")
else:
    print("   every verdict, killingTest and cause identical")

# 2. Counts.
for name, want in (("killed", PRE["killed"]), ("survived", PRE["survived"])):
    got = r4["counts"][name]
    print(f"\n2. counts.{name:9s} {ok(got == want)}  want {want}, got {got}")
    if got != want:
        fails.append(f"counts.{name}")

# 3. warmKills and groupedCalls.
wk, gc = r4.get("warmKills"), r4.get("groupedCalls")
print(f"\n3. warmKills      {ok(wk == PRE['warmKills'])}  want {PRE['warmKills']}, got {wk}")
print(f"   groupedCalls   {ok(gc == PRE['groupedCalls'])}  want {PRE['groupedCalls']}, got {gc}")
if wk != PRE["warmKills"]:
    fails.append("warmKills")
if gc != PRE["groupedCalls"]:
    fails.append("groupedCalls")

# 4. killPosition against run 3's computed positions.
p3 = positions_from_store(R3)
def store_key(m):
    """The key `positions_from_store` produces: identity plus the store's `identity_ordinal`.

    The store puts a TRIGGER's name in `procedure_name` (that is the identity slot), while the
    report leaves `procedureName` empty and carries `triggerName` beside it. Keying on the
    report's empty string missed all 7 trigger mutants, and each then fell to the comparison's
    default of position 1 - which read as "run 3 killed it first" and was never a measurement.
    """
    return (base(m["file"]), m["line"], m["operatorName"],
            m.get("procedureName") or m.get("triggerName"),
            m.get("astHash"), m.get("identityOrdinal", 0))

p4 = {store_key(m): m.get("killPosition") for m in r4["mutants"]
      if m["verdict"] in ("killed", "timeout-killed")}
missing_pos = [k for k, v in p4.items() if v is None]
absent = [k for k in p4 if k not in p3]
diff_pos = {k: (p3[k], p4[k]) for k in p4 if k in p3 and p4[k] is not None and p4[k] != p3[k]}
print(f"\n4. killPosition   {ok(not missing_pos and not diff_pos)}")
print(f"   kills with a position: {len(p4) - len(missing_pos)}/{len(p4)}")
if missing_pos:
    print(f"   MISSING a position: {missing_pos[:6]}")
    fails.append("killPosition missing")
if absent:
    print(f"   {len(absent)} run-4 kill(s) have NO run-3 counterpart to compare against"
          f" (never defaulted): {[f'{k[0]}:{k[1]} {k[2]}' for k in absent[:6]]}")
    fails.append("no run-3 counterpart")
if diff_pos:
    print(f"   {len(diff_pos)} differ from run 3's computed position (first 20):")
    for k, (a, b) in sorted(diff_pos.items(), key=lambda kv: str(kv[0]))[:20]:
        print(f"     {k[0]}:{k[1]} {k[2]}: run3 {a} -> run4 {b}")
    fails.append("killPosition moved")
print(f"   warm (position > 1): {sum(1 for v in p4.values() if (v or 1) > 1)}"
      f"   (run 3 computed: {sum(1 for v in p3.values() if v > 1)})")

# 5. The new causes: all must be zero.
causes = collections.Counter(m.get("cause") for m in r4["mutants"] if m.get("cause"))
print()
for c in ("session-reused", "warm-prefix-unstable", "warm-timeout-unconfirmed",
          "warm-confirmation-incomplete", "unstable"):
    n = causes.get(c, 0)
    print(f"5. cause {c:30s} {ok(n == 0)}  got {n}")
    if n:
        fails.append(f"cause {c}")
        for m in r4["mutants"]:
            if m.get("cause") == c:
                print(f"     {label(m)}")
                print(f"       {(m.get('failureNote') or '')[:300]}")
if causes:
    print(f"   all causes present: {dict(causes)}")

# 6. The named near-cap mutants, by SITE.
print("\n6. THE NAMED RISK (near-cap), identified by SITE - the codes are ambiguous")
for fname, line, op, pos3, prefix_s in NEAR_CAP:
    m = next((x for x in r4["mutants"]
              if base(x["file"]) == fname and x["line"] == line and x["operatorName"] == op), None)
    if m is None:
        print(f"   {fname}:{line} {op}: ABSENT from run 4")
        fails.append("near-cap mutant absent")
        continue
    print(f"   {fname}:{line} {op}  (run 3: position {pos3}, prefix {prefix_s}s of a 90s cap)")
    print(f"     run 4: {m['verdict']}, killPosition {m.get('killPosition')}, cause {m.get('cause')}")

# 7. The cost cut.
s3, s4 = survivor_seconds(r3), survivor_seconds(r4)
print(f"\n7. SURVIVOR TOTAL {ok(s4 < PRE['survivorSeconds'])}")
print(f"   run 3: {s3:.0f} s   run 4: {s4:.0f} s   target < {PRE['survivorSeconds']:.0f} s"
      f"   ({(1 - s4 / s3) * 100:+.1f}% vs run 3)")
if s4 >= PRE["survivorSeconds"]:
    fails.append("survivor seconds")

# 8. Per-method cost.
m3, m4 = per_method_ms(R3), per_method_ms(R4)
if m3 and m4:
    print("\n8. PER-METHOD COST (the design's target: 140-200 ms)")
    print(f"   run 3: median {m3[len(m3)//2]} ms, p90 {m3[int(len(m3)*0.9)]} ms, n={len(m3)}")
    print(f"   run 4: median {m4[len(m4)//2]} ms, p90 {m4[int(len(m4)*0.9)]} ms, n={len(m4)}")

# 9. Wall clock.
print(f"\n9. WALL CLOCK   run 3: {r3['timings']['totalMs']/60000:.1f} min"
      f"   run 4: {r4['timings']['totalMs']/60000:.1f} min")

print("\n" + "=" * 78)
print("VERDICT: " + ("ALL PRE-COMMITTED NUMBERS HELD" if not fails else "FINDINGS: " + ", ".join(fails)))
print("=" * 78)
sys.exit(1 if fails else 0)
