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
 *   - Only `lethal.remove-commit` and `lethal.swap-modify-flag` tag sites today (R138 added its
 *     `Insert` skip, R165 its forced trigger, R281 its `Delete` skip). R281's tag cannot see a delete
 *     subscriber or `tableextension` delete trigger in ANOTHER app (the test app, say), so a table
 *     it proves harmless here can still leave rows behind through one of those. Other operators
 *     produce platform-refused kills too — R82's arm E is a
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
    "it is kept wherever LethAL cannot prove skipping `OnInsert` harmless, which includes an " +
    "`OnInsert` that calls a procedure (one may fill the key), an insert-event subscriber or " +
    "`tableextension` insert trigger in this project, and every table it cannot read, such as a " +
    "base-app record. It is dropped only where nothing in this project observes the table's " +
    "inserts and `OnInsert` is absent, or has a readable primary key, assigns neither a key field " +
    "nor the whole record, and makes no call outside a short list of non-writing ones. A changed " +
    "value of a non-key field is not screened: that kill is the test's. It cannot see a " +
    "subscriber in another app. Treat it as a prompt to read the kill, not as a verdict on it.",
  "run-trigger-skipped-delete":
    "rewriting `Delete(true)` to `Delete(false)`, or `DeleteAll(true)` to `DeleteAll(false)`, " +
    "skips `OnDelete`. The table's delete events still fire, with `RunTrigger` false, so a " +
    "subscriber that branches on that flag, or on state the skipped trigger would have changed, " +
    "behaves differently too. When the skipped code deletes or writes OTHER rows (child lines, a " +
    "log row), those rows are left behind, and a later insert of one can raise a duplicate key " +
    "before any assertion runs. Kept wherever LethAL cannot prove the skipped code harmless, which includes every table " +
    "it cannot read, such as a base-app record. It cannot see a delete subscriber or a " +
    "`tableextension` delete trigger in another app (the test app, say). WEAK, like the `Insert` " +
    "tag: the duplicate-key route is not measured live for `Delete`, and whether `RunTrigger` " +
    "changes how BC deletes record links, notes or media is not measured either. Treat it as a " +
    "prompt to read the kill, not as a verdict on it.",
  "run-trigger-skipped-modify":
    "rewriting `Modify(true)` to `Modify(false)`, or `ModifyAll(Field, Value, true)` to " +
    "`ModifyAll(Field, Value, false)`, skips `OnModify`. The table's modify events still fire, " +
    "with `RunTrigger` false, so a subscriber that branches on that flag, or on state the skipped " +
    "trigger would have changed, behaves differently too. When the skipped code deletes or writes " +
    "OTHER rows, those writes do not happen, and a later statement can " +
    "raise on the rows they would have changed (a duplicate key, a missing record) before any " +
    "assertion runs. Kept wherever LethAL cannot prove the skipped code harmless, which includes " +
    "every table it cannot read, such as a base-app record. SCOPE: it reads only this project. A " +
    "modify subscriber or `tableextension` modify trigger in another app (the test app, say) is " +
    "not read, so finding none here is not proof that none exists. WEAK, like the `Delete` tag: " +
    "the route is not measured live. Treat it as a prompt to read the kill, not as a verdict on it.",
  "run-trigger-forced":
    "rewriting `Modify()` or `Modify(false)` to `Modify(true)` (and the same for `Insert`, " +
    "`Delete`, `ModifyAll(Field, Value, false)` and `DeleteAll(false)`) makes the table's trigger " +
    "RUN where it did not, and raises its events with `RunTrigger` true. Forcing a trigger writes " +
    "more than the unmutated program, so unlike skipping one it can add an error the suite never " +
    "had to catch: an `Error`, a `TestField`, a `FieldError`, or a write to another table hitting " +
    "a duplicate key or a locked row. Kept unless LethAL proves the table has no such trigger and " +
    "no subscriber or `tableextension` trigger for it in this project. No trigger body is read, so " +
    "every table with that trigger keeps it, and so does every table it cannot read, such as a " +
    "base-app record. SCOPE: it reads only this project. A subscriber or `tableextension` trigger " +
    "in another app (the test app, say) is not read, so finding none here is not proof that none " +
    "exists. Treat it as a prompt to read the kill, not as a verdict on it.",
};
