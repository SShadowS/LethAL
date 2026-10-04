/**
 * R246. The procedure-local Boolean that latches the marker after its first hit. A marker inside a
 * loop otherwise costs two calls (selector, then `LC Control State.NoteReached`) per iteration,
 * which turned `itest:hang`'s 4.4 s Int32-overflow kill into a timeout. With the latch the hot path
 * is one test of a local. It is a LOCAL of the enclosing procedure or trigger (declared by
 * `planFile`'s `injectReachLatches`), so it starts false on every call: it cannot outlive a test
 * method, and so cannot survive any of the control app's `ObservedActive` resets, which all run
 * between tests. The first hit still reaches `NoteReached`, so a mismatched tuple still latches
 * `ObservedIdentityMismatch` there.
 *
 * This is the DEFAULT name. Where it is already an identifier in the procedure's scope, PLAN picks
 * a suffixed one per procedure (`latchNameFor` in compile-plan.ts) and EMIT writes that one.
 *
 * R-307 O5: a module of its own, neither PLAN nor EMIT, because both read it: PLAN names latches by
 * it, and EMIT's `REACH_MARKER` defaults to it. EMIT may not import a value from a PLAN module.
 */
export const REACH_LATCH = "LethALReachLatch";
