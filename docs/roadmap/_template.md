# LethAL Roadmap — open work and known limitations

<!-- GENERATED FILE. Do not edit ROADMAP.md. Edit docs/roadmap/R<nnn>.md, or this header in
     docs/roadmap/_template.md, then run `bun scripts/roadmap-index.ts`. -->

Living list of everything known-but-not-done: planned work, correctness risks we have measured and
not yet closed, and product gaps a real user would hit. Session ledgers under `.superpowers/` are
scratch and get archived; **`docs/roadmap/` is the durable record.**

**This page is generated.** One item = one file, `docs/roadmap/R<nnn>.md`; this index is built from
them by `bun scripts/roadmap-index.ts` and must never be hand-edited. Reading an item means reading
its file — which is also why the old single-table form is gone: its cells contained inline `|`, so
a field-wise read silently returned a fraction of a row and looked complete (R118).

## How to use this file

- **Add an item the moment it is discovered**, even mid-task — one line of "what breaks, for whom"
  beats a perfect write-up later. Items get a stable `R<n>` id; never renumber, never reuse an id.
  Adding one means writing `docs/roadmap/R<nnn>.md` (zero-padded) and re-running the generator;
  two sessions filing at once cannot collide.
- **Every item names its evidence** — a file, a commit, a measured result. An item with no evidence
  pointer is a rumour, not a roadmap entry.
- **Status:** `open` · `in progress` · `blocked (<on what>)` · `done (<commit>)`. The `status`
  frontmatter field holds it in full; this index shows an abbreviation.
- **Closing an item:** mark it `done` with the commit, leave it in place for one release cycle, then
  delete its file. Deleted items live on in git history.
- **Do not** duplicate what the code or `design.md` already says. This file records what is *missing*
  or *wrong*, not how the system works.

Priority is deliberately not a column: the `order` field sets the ordering inside each section, and
that ordering is the priority.

---

## Next up

<!-- rows: next-up -->

## Correctness risks (measured, not closed)

<!-- rows: correctness-risks -->

## Product gaps a real project hits

<!-- rows: product-gaps -->

## Backends and tooling

<!-- rows: backends-and-tooling -->

---

**Recently closed** (delete these once a release has passed):

- Tier-2 Phase 0 — table triggers mutate, execute and kill on a live server; merged 2026-07-25 (`841069c`), frozen at `itest:tables` 3 killed / 2 survived / 2 no-coverage. Superseded by Phase 1's 63 / 10 / 2 over the same, larger fixture.
- Tier-2 Phase 1 (R10) and the live dedup-collision proof (R12) — see their rows above.
- Coverage keyed on `(objectType, objectId)` rather than the bare id (`6e89948`) — a table and a codeunit sharing an id sent a trigger mutant at the wrong object's tests.
- Per-mutant time budget floored at 30 s (`ab58469`) — an unfloored `2 × baseline` quarantined a cold start as in-flight-unknown.
