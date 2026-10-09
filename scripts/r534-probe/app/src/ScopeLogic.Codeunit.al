codeunit 79681 "R534 Scope Logic"
{
    // A mutant that flips the guard reaches TaskScheduler, which al-runner refuses (out of scope).
    procedure MaybeTask(Ask: Boolean): Boolean
    begin
        if Ask then
            exit(TaskScheduler.TaskExists(CreateGuid()));
        exit(true);
    end;
}
