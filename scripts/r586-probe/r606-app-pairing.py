"""R-606 sandbox-app (scratch only): pair each serve request with its activation and `cached`.
Activation order comes from the leg's store (test_results by id, grouped by mutant_code + op_kind);
`cached` and wallSeconds from <leg>.serve-out.ndjson, in order.
  python3 -I r606-app-pairing.py <dir> <leg>"""
import itertools
import json
import sqlite3
import statistics
import sys

d, leg = sys.argv[1], sys.argv[2]
rows = sqlite3.connect(f"{d}/{leg}-scratch/lethal.sqlite").execute(
    "select mutant_code, op_kind from test_results order by id").fetchall()
acts = [k[0] or "unmutated" for k, _ in itertools.groupby(rows)]
summ = [json.loads(x) for x in open(f"{d}/{leg}.serve-out.ndjson") if x.strip()]
reqs = [json.loads(x) for x in open(f"{d}/{leg}.serve-in.ndjson") if x.strip()]
n_req = sum(1 for q in reqs if q.get("command") == "runTests")
print(f"{leg}: runTests={n_req} summaries={len(summ)} activation-groups={len(acts)}")
assert len(acts) == len(summ) == n_req, "request / summary / activation counts disagree"
repeat = 0
for i, (a, s) in enumerate(zip(acts, summ)):
    rep = i > 0 and acts[i - 1] == a
    repeat += rep
    print(f"  {i + 1:2} {a:10} cached={str(s['cached']).lower():5} notRun={s.get('notRun')} {s['wallSeconds'] * 1000:8.1f} ms{'  REPEAT' if rep else ''}")
for c in (True, False):
    ms = [s["wallSeconds"] * 1000 for s in summ if s["cached"] is c]
    print(f"  cached={str(c).lower()}: n={len(ms)} median={statistics.median(ms):.1f} ms" if ms else f"  cached={str(c).lower()}: n=0")
print(f"  repeat activations: {repeat}; notRun>0 summaries: {sum(1 for s in summ if (s.get('notRun') or 0) > 0)}")
