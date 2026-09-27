# Emit one JSON record per syntax node, from the AL compiler's OWN parser, for the issue #6 audit.
#
# `Microsoft.Dynamics.Nav.CodeAnalysis` ships inside the AL Language extension this repository
# already requires for `alc`, so this needs no new dependency. `ParseObjectText` is pure syntax:
# no symbols, no `.alpackages`, no project, which is why the audit can run per file.
#
# Usage:  pwsh -File dump-compiler-kinds.ps1 -AlcBin <dir> -ListFile <file> -OutFile <kinds.ndjson>
#
# Output is NDJSON (one JSON object per line, UTF-8 without BOM, LF line ends), written to -OutFile
# as each file is parsed, so memory does not grow with the corpus. (Holding every node for one
# ConvertTo-Json drove pwsh to 16.4 GB private on BaseApp/Test, Task 6b.) Three record types:
#
#   {"t":"file","path":"<absolute path>"}          written before that file's nodes
#   {"t":"node","kind":"<Kind>","start":<n>,"end":<n>,"parent":"<Kind, or empty for the root>"}
#   {"t":"summary","parserVersion":"<v>","fileCount":<n>,"parseErrors":<n>,"parseErrorFiles":[...]}
#
# A node belongs to the most recent `file` record. The summary is written LAST: a dump without one
# was cut short, and the reader (`readCompilerDump` in grammar-crosscheck.ts) throws rather than
# read it as a smaller corpus. Offsets are .NET TextSpan positions, i.e. UTF-16 code units, the
# same unit web-tree-sitter reports for a JS string. Measured equal on non-ASCII text 2026-09-27
# (scripts/lib/grammar-crosscheck.test.ts).

param(
  [Parameter(Mandatory = $true)][string]$AlcBin,
  # One absolute .al path per line, built by the caller from `corpusEntries()` so both parsers
  # read exactly the files the corpus fingerprint names (.dependencies excluded, R187).
  [Parameter(Mandatory = $true)][string]$ListFile,
  [Parameter(Mandatory = $true)][string]$OutFile
)

$ErrorActionPreference = "Stop"

$dll = Join-Path $AlcBin "Microsoft.Dynamics.Nav.CodeAnalysis.dll"
if (-not (Test-Path $dll)) { throw "not found: $dll" }
$asm = [System.Reflection.Assembly]::LoadFrom($dll)
$treeType = $asm.GetType("Microsoft.Dynamics.Nav.CodeAnalysis.Syntax.SyntaxTree")
if ($null -eq $treeType) { throw "SyntaxTree type not found in $dll" }

$files = @(Get-Content -LiteralPath $ListFile | Where-Object { $_ -ne "" } | ForEach-Object { Get-Item -LiteralPath $_ })

# A JSON string literal: backslash, quote and control characters escaped, everything else written
# raw (the file is UTF-8). Used for paths, once per file rather than per node. Node kinds are .NET
# enum member names, so they are written without escaping.
function ConvertTo-JsonString([string]$s) {
  $sb = [System.Text.StringBuilder]::new($s.Length + 2)
  [void]$sb.Append('"')
  foreach ($c in $s.ToCharArray()) {
    if ($c -eq [char]'"') { [void]$sb.Append('\"') }
    elseif ($c -eq [char]'\') { [void]$sb.Append('\\') }
    elseif ([int]$c -lt 0x20) { [void]$sb.Append(('\u{0:x4}' -f [int]$c)) }
    else { [void]$sb.Append($c) }
  }
  [void]$sb.Append('"')
  return $sb.ToString()
}

$parseErrorFiles = New-Object System.Collections.Generic.List[string]
$w = [System.IO.StreamWriter]::new($OutFile, $false, [System.Text.UTF8Encoding]::new($false))
$w.NewLine = "`n"
try {
  foreach ($f in $files) {
    $src = [System.IO.File]::ReadAllText($f.FullName)
    $tree = $treeType::ParseObjectText($src, $f.FullName, $null, $null, [System.Threading.CancellationToken]::None)
    if ($null -eq $tree) { $parseErrorFiles.Add($f.FullName); continue }

    # A file the compiler cannot parse cleanly is named rather than silently contributing zero
    # nodes: an empty result and a failed parse must not look alike. Its nodes are still emitted
    # below either way; the TypeScript side decides whether to drop them (C1), so the decision lives
    # in one tested place, not split across a PowerShell script and a TS module.
    $errs = @($tree.GetDiagnostics([System.Threading.CancellationToken]::None)) |
      Where-Object { $_.Severity -eq "Error" }
    if ($errs.Count -gt 0) { $parseErrorFiles.Add($f.FullName) }

    $w.WriteLine('{"t":"file","path":' + (ConvertTo-JsonString $f.FullName) + '}')
    $root = $tree.GetRoot([System.Threading.CancellationToken]::None)
    foreach ($n in $root.DescendantNodes()) {
      $span = $n.Span
      # `parent` carries the context probes' answer (see CONTEXT_PROBES in al-kind-mapping.ts). A
      # node-kind comparison alone is blind to the statement_block class of regression, where the
      # nodes are all present at the same offsets and only their PARENT changed.
      $parentKind = if ($null -ne $n.Parent) { $n.Parent.Kind.ToString() } else { "" }
      $w.WriteLine('{"t":"node","kind":"' + $n.Kind.ToString() + '","start":' + $span.Start +
        ',"end":' + $span.End + ',"parent":"' + $parentKind + '"}')
    }
  }

  $errFiles = @($parseErrorFiles | ForEach-Object { ConvertTo-JsonString $_ }) -join ","
  $w.WriteLine('{"t":"summary","parserVersion":' + (ConvertTo-JsonString $asm.GetName().Version.ToString()) +
    ',"fileCount":' + @($files).Count + ',"parseErrors":' + $parseErrorFiles.Count +
    ',"parseErrorFiles":[' + $errFiles + ']}')
} finally {
  $w.Dispose()
}
