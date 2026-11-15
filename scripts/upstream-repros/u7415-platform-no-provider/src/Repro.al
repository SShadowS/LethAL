// Upstream #7415 (PR-13): a read of a platform table al-runner's store has no provider for. Invented, no corpus source text.
// The four tables LethAL's corpus runs met (Api Web Service by far the most), and the issue's own All Control Fields.
// On BC a read of a platform table returns (rows or none), so each test is expected to pass.
codeunit 51301 "U7415 Api Web Service"
{
    Subtype = Test;

    [Test]
    procedure Cell()
    var
        R: Record "Api Web Service";
    begin
        if R.IsEmpty() then;
    end;
}

codeunit 51302 "U7415 Tenant Media Set"
{
    Subtype = Test;

    [Test]
    procedure Cell()
    var
        R: Record "Tenant Media Set";
    begin
        if R.IsEmpty() then;
    end;
}

codeunit 51303 "U7415 Object Metadata"
{
    Subtype = Test;

    [Test]
    procedure Cell()
    var
        R: Record "Object Metadata";
    begin
        if R.IsEmpty() then;
    end;
}

codeunit 51304 "U7415 Perf Profile Scheduler"
{
    Subtype = Test;

    [Test]
    procedure Cell()
    var
        R: Record "Performance Profile Scheduler";
    begin
        if R.IsEmpty() then;
    end;
}

codeunit 51305 "U7415 All Control Fields"
{
    Subtype = Test;

    [Test]
    procedure Cell()
    var
        R: Record "All Control Fields";
    begin
        if R.IsEmpty() then;
    end;
}
