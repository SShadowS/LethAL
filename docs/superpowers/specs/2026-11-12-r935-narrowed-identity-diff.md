# R-935 part 2: a narrowed identity diff (design, 2026-11-12)

Coord task R-935, lane preproc. The brief asks for two things that pull apart:
an `auto` mode that picks projects "by the changed emit/operator paths", and "a narrowed run that misses a changed project must be
impossible".

## What was measured

- The two known diffs are XMLport changes. R919 (coord R-919, `/coord/handoff/R-919/five/bch.diff.txt`) moved 13 of 519 BC.History
  projects; R928 (coord R-923, `/coord/handoff/R-923/r928/bch/bch.diff2.txt`) moved 3.
- A shape rule "a project with any `.al` file, nested ones included, whose text matches `\bxmlport\b` (any case)" selects 46 of 519
  projects. It holds all 13 and all 3. The scan takes 0.2 s.
- The fixes changed shared files. R928's fix (d5eb16ff) changed only `packages/builtin-tier1/src/loop-hazard.ts`, in functions that
  report data items use too (`isLoopItem`, `dataItemOpenOnce`). R919's branch changed 78 files in runner and schemata.

## Why a rule from changed paths cannot be sound

No generation file is limited to one AL shape. `loop-hazard.ts` judges every loop: code loops in every object, report data items,
XMLport elements and queries. Even an operator's own file is not limited: an edit can make the operator match a new kind of syntax,
and then projects without the old syntax change too. So a table "path -> shape" can miss a changed project. A rule like that is the
change author's claim about what the change touches; the tool cannot check it from the path.

## Built (sound in every case the shape claim is right; the tool says which it ran)

- `diff <set> --shape <name>[,<name>...]`: the projects holding a named shape. Shapes are a fixed table of loose text matches (a
  superset by design: a comment or a variable naming the kind also selects the project). The first shape is `xmlport`.
- The report's first line says what ran: `scope: full (N projects)`, `scope: narrowed by --projects (N of M; your list, not checked)`
  or `scope: narrowed by --shape xmlport (N of M; the shape is your claim about the change)`.
- Proven a superset on both known diffs by a test that reads the two committed project lists (names only, no source).
- The full diff stays the default, and `bch` still needs `--all`, `--projects` or `--shape`.

## Asked of the owner

Should `--projects auto` exist as "shapes from a table of changed paths", with the limit above stated in the tool's output and the
full diff required once on the final head? Or should the shape always be named by the lane (`--shape`), with no `auto`?
Recommendation: no `auto` from paths (principles 1 and 5); `--shape` named per change, and the change's own pre-commitment says
which shape it claims.
