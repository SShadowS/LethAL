/**
 * R72 — screening the kills that the PLATFORM produced rather than the suite.
 *
 * WHY THIS EXISTS. A mutation score reads as a statement about a test suite. When BC refuses to run
 * the mutated program at all, the mutant dies without any assertion having noticed anything, and the
 * score goes UP. That error flatters the suite, which is the bad direction: the reader concludes
 * their tests caught something the platform caught.
 *
 * `lethal.remove-commit` has two entirely different kill mechanisms and this separates them. Delete
 * a `Commit()` before an ordinary failure and the committed write rolls back with the error, which
 * a test asserting the row survived NOTICES — real assertion quality. Delete a `Commit()` before a
 * `Codeunit.Run` whose RETURN VALUE is consumed and BC aborts the whole transaction, which says
 * nothing about anything the suite does.
 *
 * MEASURED, not assumed. `scripts/r72-probe/` ran a 2x2x2 over prior `Commit()`, call frame and
 * call form on Cronus281 (BC 28.0.46665.49944) through the fenced path, plus two controls, plus a
 * later pair of arms for the guard form. The return-value form is the only factor: it aborts in both
 * frames, with and without a prior commit, whether written `Ran := Codeunit.Run(X)` or
 * `if not Codeunit.Run(X) then ...`, and the bare statement `Codeunit.Run(X);` survives in every
 * cell. Full table in `docs/measurements/README.md` §R72.
 *
 * WHAT IT IS, AND WHAT IT DELIBERATELY IS NOT.
 *
 *   - It is a SCREEN, not a classifier. It says "these kills sit at a site whose mutation the
 *     platform is known to refuse; read them", and it never says any one of them is false. The
 *     wording below carries that hedge, and it must keep carrying it.
 *   - It NEVER moves a verdict. A killed mutant carrying this stays `killed` (design §6.7's timeout
 *     precedent; R121 obeys the same rule). Re-scoring would invalidate every frozen gate figure in
 *     `CLAUDE.md` and every committed baseline under `docs/campaign/`.
 *   - It is SYNTACTIC, never a message match. BC's own refusal text is the generic "An error
 *     occurred and the transaction is stopped. Contact your administrator or partner for further
 *     assistance." — it names neither `Codeunit.Run` nor the rule, so a detector keyed on it would
 *     fire on any platform-stopped transaction and mislabel genuine kills. It also localises (R66),
 *     which would make the screen English-only. R121 measured how much that ceiling costs: on a real
 *     73-kill corpus the only 100%-precision rule anyone found was a message text.
 *
 * WHAT IT CANNOT SEE, stated because a screen that hides its own reach is worse than none:
 *
 *   - Only `lethal.remove-commit` and `lethal.swap-modify-flag`'s `Insert` mutants tag sites today
 *     (R138 added the second). Other operators produce platform-refused kills too — R82's arm E is a
 *     swap killed by a BC field-length overflow, and the table fixture's arm K reaches its
 *     duplicate-key error by two further routes, an `empty-block` on the `OnInsert` body and a
 *     `negate-conditional` on its blank-key guard, neither of which is tagged. An absent tag is not
 *     a claim that a kill was assertion-earned.
 *   - The tag is a property of the SITE, decided before anything ran, so a tagged kill MIGHT still
 *     have been earned by an assertion in a covering test that failed for its own reasons before the
 *     refusal was reached. That is exactly why this reads "read these" and not "these are false".
 */

import type { PlatformKillMechanism } from "@lethal/engine";

/** `SessionReport.platformArtifactKills.diagnosis`, stated once so the report and any consumer
 *  reading the constant cannot drift into two accounts of one fact. */
export const PLATFORM_ARTIFACT_KILL_DIAGNOSIS =
  "These mutants were scored `killed`, and they stay killed — this is an annotation, not a " +
  "re-score. What it adds is that each one sits at a site where Business Central can refuse the " +
  "mutated program outright, so a kill there can be the platform rather than anything your tests " +
  "assert. Read them before crediting them to the suite. LethAL does not claim any particular one " +
  "of them is false: it screens on the site, which it can prove, not on the reason the test went " +
  "red, which it cannot. How strongly each mechanism is evidenced differs, and each says so in " +
  "its own explanation below.";

/**
 * What each recognised mechanism means, keyed on the tag an operator writes into
 * `MutationSpec.platformKillMechanism`.
 *
 * A `Record` over the closed set rather than a lookup with a default: a tag nobody wrote an
 * explanation for must be a compile error here, not a mutant screened with an empty reason.
 */
export const PLATFORM_KILL_MECHANISM_EXPLANATIONS: Record<PlatformKillMechanism, string> = {
  "write-txn-codeunit-run":
    "the deleted `Commit()` can leave a write transaction open across a later `Codeunit.Run` whose " +
    "return value is consumed (`Ran := Codeunit.Run(X)`, or `if not Codeunit.Run(X) then ...`), " +
    "and BC aborts the whole transaction there — measured on Cronus281, in both call frames, with " +
    "and without a prior `Commit()`. The bare statement form `Codeunit.Run(X);` does not abort and " +
    "is not tagged. STRONG: a detector fires only on that measured shape.",
  "run-trigger-skipped-insert":
    "rewriting `Insert(true)` to `Insert(false)` skips `OnInsert`. On a table whose `OnInsert` " +
    "assigns the primary key that leaves the key blank: the first blank-key insert succeeds " +
    "(blank is a legal `Code[20]`) and a second raises a duplicate primary key, or a later " +
    "`Get`/`Modify` on the expected key raises that the record does not exist. The test then dies " +
    "on the platform before evaluating any assertion. WEAKER THAN THE ABOVE, and deliberately so: " +
    "every `Insert` mutant carries this tag, because whether the target table's `OnInsert` touches " +
    "the primary key is not visible at the call site, and for a base-app record it is not visible " +
    "at all. Treat it as a prompt to read the kill, not as a verdict on it.",
  "run-trigger-forced":
    "rewriting `Modify()` to `Modify(true)` makes the table's `OnModify` RUN where it did not — " +
    "`Rec.Modify()` means `RunTrigger = false`. Forcing a trigger writes more than the unmutated " +
    "program, so unlike skipping one it can add an error the suite never had to catch: an " +
    "`Error`, a `TestField`, a `FieldError`, or a write to another table hitting a duplicate key " +
    "or a locked row. STRONGER THAN `run-trigger-skipped-insert`: this operator is scoped to " +
    "tables this project declares AND that declare the trigger, so the tag is emitted only where " +
    "the trigger body PROVABLY contains a raise-capable statement, never as a blanket. It " +
    "under-tags for a raise reached through a project procedure, which is the honest direction " +
    "for a screen whose value is that a tag means something.",
};
