"""R85 instrument (b): apply the pre-registered seeded rule to pick the run scope.

Rule, fixed before any verdict is seen:
  1. Take the swap-bearing files (those holding >=1 `lethal.swap-call-arguments` site).
  2. Sort by path, then shuffle with mulberry32 seeded 20260807 -- the sort makes the shuffle
     the only source of randomness.
  3. Walk the shuffled order. Admit a file if it keeps cumulative DEPLOYED mutants <= BUDGET;
     otherwise skip it and continue. Deployed, not sites: R92 exists because a plan that
     pre-commits the site count as the mutant count is wrong by up to 16%.
"""

import io
import re
import sys

SEED = 20260807
BUDGET = int(sys.argv[1]) if len(sys.argv) > 1 else 900
SP = "C:/Users/SShadowS/AppData/Local/Temp/claude/U--Git-LethAL/90310340-bb2f-4fbc-8083-4f3f2e4a23bb/scratchpad"


def mulberry32(a):
    state = [a & 0xFFFFFFFF]

    def rnd():
        state[0] = (state[0] + 0x6D2B79F5) & 0xFFFFFFFF
        t = state[0]
        t = (t ^ (t >> 15)) * (1 | t) & 0xFFFFFFFF
        t = (t + ((t ^ (t >> 7)) * (61 | t) & 0xFFFFFFFF)) & 0xFFFFFFFF ^ t
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296

    return rnd


# swap-bearing files, by basename
swap_counts = {}
for line in io.open(f"{SP}/keys-after.txt", encoding="utf-8"):
    line = line.strip()
    if not line:
        continue
    path = line.split("|")[0].replace("\\", "/")
    base = path.rsplit("/", 1)[-1]
    swap_counts[base] = swap_counts.get(base, 0) + 1

# deployed counts per file, from the whole-project dry run
deployed = {}
for line in io.open(f"{SP}/perfile.txt", encoding="utf-8"):
    m = re.search(r"^\s+(.*\.al)\s+sites=(\d+)\s+deployed=(\d+)", line.rstrip("\n"))
    if m:
        base = m.group(1).replace("\\", "/").rsplit("/", 1)[-1]
        deployed[base] = int(m.group(3))

files = sorted(swap_counts)
missing = [f for f in files if f not in deployed]
rnd = mulberry32(SEED)
for i in range(len(files) - 1, 0, -1):
    j = int(rnd() * (i + 1))
    files[i], files[j] = files[j], files[i]

chosen, total_dep, total_swap, skipped = [], 0, 0, 0
for f in files:
    d = deployed.get(f)
    if d is None:
        continue
    if total_dep + d <= BUDGET:
        chosen.append(f)
        total_dep += d
        total_swap += swap_counts[f]
    else:
        skipped += 1

print(f"seed={SEED} budget={BUDGET}")
print(f"swap-bearing files={len(swap_counts)}  no deployed figure={len(missing)}")
print(f"CHOSEN files={len(chosen)}  deployed={total_dep}  swap mutants={total_swap}  skipped={skipped}")
io.open(f"{SP}/chosen.txt", "w", encoding="utf-8", newline="\n").write("\n".join(chosen) + "\n")
for f in chosen:
    print(f"  {swap_counts[f]:3d} swap  {deployed[f]:4d} deployed  {f}")
