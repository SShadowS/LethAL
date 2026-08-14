// R132 assert probe -- MEASURES the exact text a Microsoft Library Assert failure produces, and
// proves that a fixture on these containers can take a dependency on that app at all.
//
// R121's assertion screen keys on one thing: does a kill's failure message begin with `Assert.`?
// Every LethAL fixture raises through bare `Error(...)`, so on every live gate the screen flags
// EVERY kill and separates nothing (`discrimination: "vacuous"`). R132 exists because the `partial`
// branch -- the only one where a reader is told something actionable -- has never run live.
//
// Two things have to be true before any fixture grows an `Assert.*` arm, and both are measurable
// rather than arguable:
//
//   1. A dependency on Microsoft's `Library Assert` compiles here and publishes to the container.
//      Its symbols come from the container itself (dev endpoint `dev/packages`).
//   2. The failure text really does start with `Assert.` on THIS BC build. The AL source says
//      `Assert.AreEqual failed. Expected:<%1> (%2). Actual:<%3> (%4). %5` with `Locked = true`, so
//      it should not localise -- but "should not" is exactly the kind of claim this project
//      measures. If the prefix differed, a fixture arm built on it would report `vacuous` after a
//      full gate run instead of the `partial` it was built for.
//
// Results travel out through Error() -- a passing test reports nothing. This [Test] is EXPECTED to
// show as failed.
namespace LethAL.R132;

using System.TestLibraries.Utilities;

codeunit 71531 "R132 Assert Probe Tests"
{
    Subtype = Test;
    TestPermissions = Disabled;

    [Test]
    procedure LibraryAssertFailureTextShape()
    var
        ErrorMsg: Text;
    begin
        if TryFailingAreEqual() then
            Error('MEASURED: Library Assert.AreEqual(1, 2) did NOT raise, which contradicts its own contract');
        ErrorMsg := GetLastErrorText();
        Error('MEASURED AreEqual text: %1', ErrorMsg);
    end;

    [Test]
    procedure LibraryAssertIsTrueTextShape()
    var
        ErrorMsg: Text;
    begin
        if TryFailingIsTrue() then
            Error('MEASURED: Library Assert.IsTrue(false) did NOT raise');
        ErrorMsg := GetLastErrorText();
        Error('MEASURED IsTrue text: %1', ErrorMsg);
    end;

    [TryFunction]
    local procedure TryFailingAreEqual()
    var
        LibraryAssert: Codeunit "Library Assert";
    begin
        LibraryAssert.AreEqual(1, 2, 'probe message');
    end;

    [TryFunction]
    local procedure TryFailingIsTrue()
    var
        LibraryAssert: Codeunit "Library Assert";
    begin
        LibraryAssert.IsTrue(false, 'probe message');
    end;
}
