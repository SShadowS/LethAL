# R810 pre-commitment: re-record the 12 baselines at identity scheme 42

Written 2026-11-05 by lethal-code, coord task R-824, before any build and before any record run. Basis: R332's procedure,
R556 (the scheme field and the text check), R586c's M5 (no record on a pinned build), R796 (scheme 43).

## The one prediction

Every one of the 12 files changes by exactly one line: `"identityScheme": 42` becomes `43`. No row moves: no key, verdict,
`killingTest`, `errorClass`, `coverageFiltered` or `mutatedTextSha256`, and no change of order. Any other diff line is a BLOCK
until explained in a dated addendum.

Why: R796's new parser dumps every fixture identically, and the v3 gate on R-820's head read 0 `text-UNVERIFIED` on L1, Y-A,
Y-B, MO and WR.

## What stands in the way

R810 named only leg T. The blocker is wider. `recordRefusal` (M5) refuses a record on any pinned build, and `current` always has
a pin. So all six `al-runner-v3.*` baselines refuse to record today, and `current` cannot go back.

M5's purpose stands: a pinned build must never write its own readings into a baseline, because the pins' `from` rows and the
frozen tables stand on those files.

## The rule: a record on a pinned build keeps the rows

A record on a pinned build may write only the rows already committed.

1. `recordRefusal` still refuses a candidate build. It no longer refuses a pinned build by itself.
2. On a pinned build, a record reads the file as committed at `HEAD` with `git show`, because the procedure has deleted the
   working copy. No file at `HEAD`: refused by name.
3. It takes the run's rows, in disk form. For leg T only, it first undoes the pin: each pinned key must read the pin's verdict,
   `errorClass` and `killingTest`, and goes back to the pin's `from` row, with `coverageFiltered` set as the verdict implies. A
   pinned key that does not read the pin, or that is absent or repeated: refused, nothing written.
4. Those rows must equal the committed rows exactly, every field of every row, in order. Any difference: refused, nothing
   written, naming the first differing key and the count. The record has failed; nothing is restored by hand.
5. Only then does it write the same rows at the current scheme, and exit 3 as every record does.

Leg T's old record branch (290/57/59, 3 refused tests, the 52 known differences) stays for an unpinned build. A pinned record does
not need those figures: equality with the committed rows carries them.

This is stricter than an ordinary record, which checks nothing. An unpinned record is unchanged. Equal rows are the only thing a
pinned build can write, so it can never move a verdict.

The confirm run then matters more than the record. With both sides at scheme 43, the compare is `sameScheme`, so byte-identical
twins are checked too, and leg T is judged through the pin against the rewritten file, with its refused tests and index figures.

## The procedure, literally

**The v3 six, one worktree, one run.** Delete the six files. Run the six legs (L1, Y-A, Y-B, MO, WR, T) once with
`LETHAL_ITEST_RECORD_BASELINE` naming all six: it exits 3. Re-run without the variable: all legs pass. Then the full v3 gate.

**The BC six, unpinned, unchanged code.** One gate per server, under a lease, one record at a time per worktree: delete, record
(exit 3), confirm, for `bcdev`, `bcdev.names`, `bcdev.wrapped`, `tables`, `harden` and `hang.single`. Each runs only on a server
the proof table in `docs/gates/servers.md` lists for it. `hang` is not on `bc1`. The first line of each gate names its server.

**For every file:** review the diff (one line, or BLOCK), add a dated line to the gate's page, clear it from `LAGGING_SCHEME` in the
commit that records it. `envtool.baseline.json` stays listed: it is host-only (R683).

## What this does not cover

- The BC gates' figures do not change, so no proof table row is added beyond what the runs show.
- `text-UNVERIFIED` was 0 on the five legs that print it. Leg T does not print that line: the confirm run is its first
  `sameScheme` check of the twins, so a difference there is a real finding, not a formality.

## Gates

Red tests each way for the rule above: a moved row refused, an unknown pinned key refused, a pinned key reading something else
refused, no file at `HEAD` refused, a candidate still refused, an unpinned record unchanged, and equal rows written with the new
scheme. One opus build review, CI on the final head, the full v3 gate on the final head.
