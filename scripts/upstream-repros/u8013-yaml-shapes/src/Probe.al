// PR-28 (#8013, ReadFromYaml): the YAML shapes of Microsoft's AI Test Toolkit datasets, invented (no corpus text). The control is
// the one list-of-mappings layout edge-5a58a0f16 pins (items at indent 4, under a key at indent 2); every other test changes ONE
// thing: the datasets' layout (a list at indent 0), a key with a slash, a key ending in a full stop, a decimal value, CRLF line
// endings. ReadFromYaml returning false fails the test. On BC each is ordinary YAML (inferred, not measured).
codeunit 51480 "U8013 Yaml Shapes"
{
    Subtype = Test;

    [Test]
    procedure PinnedLayout()
    begin
        Read(Doc('size', 'two', Lf()), 'control');
    end;

    [Test]
    procedure ListAtItsKeysIndent()
    begin
        // the datasets' layout: a key at indent 0 whose list is at indent 0 too, the item's other keys at indent 2
        Read('items:' + Lf() + '- name: one' + Lf() + '  size: two', 'list at its key''s indent');
    end;

    [Test]
    procedure KeyWithSlash()
    begin
        Read(Doc('unit/kind', 'two', Lf()), 'slash');
    end;

    [Test]
    procedure KeyEndingInFullStop()
    begin
        Read(Doc('count.', '3', Lf()), 'full stop');
    end;

    [Test]
    procedure DecimalValue()
    begin
        Read(Doc('rate', '1.5', Lf()), 'decimal');
    end;

    [Test]
    procedure CrLfLineEndings()
    begin
        Read(Doc('size', 'two', CrLf()), 'crlf');
    end;

    // root: / items: / - name: one / <key>: <value>, in the pinned layout
    local procedure Doc(LastKey: Text; LastValue: Text; Eol: Text): Text
    begin
        exit('root:' + Eol + '  items:' + Eol + '    - name: one' + Eol + '      ' + LastKey + ': ' + LastValue);
    end;

    local procedure Read(Yaml: Text; What: Text)
    var
        J: JsonObject;
    begin
        if not J.ReadFromYaml(Yaml) then
            Error('ReadFromYaml returned false (%1)', What);
    end;

    local procedure Lf(): Text[1]
    var
        T: Text[1];
    begin
        T[1] := 10;
        exit(T);
    end;

    local procedure CrLf(): Text[2]
    var
        T: Text[2];
    begin
        T[1] := 13;
        T[2] := 10;
        exit(T);
    end;
}
