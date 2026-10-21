codeunit 50651 "Probe Hang"
{
    Subtype = Test;

    var
        Logic: Codeunit "Probe Logic";

    [Test]
    procedure BeforeHang()
    begin
    end;

    [Test]
    procedure CpuHang()
    begin
        Logic.Spin();
    end;

    [Test]
    procedure AfterHang()
    begin
    end;

    [Test]
    procedure SleepHang()
    begin
        Sleep(600000);
    end;
}
