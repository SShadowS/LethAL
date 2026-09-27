# Emit one JSON object per syntax node, from the AL compiler's OWN parser, for the issue #6 audit.
#
# `Microsoft.Dynamics.Nav.CodeAnalysis` ships inside the AL Language extension this repository
# already requires for `alc`, so this needs no new dependency. `ParseObjectText` is pure syntax:
# no symbols, no `.alpackages`, no project, which is why the audit can run per file.
#
# Usage:  pwsh -File dump-compiler-kinds.ps1 -AlcBin <dir> -ListFile <file> > kinds.json
#
# Output is one JSON object with a `nodes` array of { file, kind, start, end, parent }. Offsets are
# .NET TextSpan positions, i.e. UTF-16 code units, the same unit web-tree-sitter reports for a JS
# string. Measured equal on non-ASCII text 2026-09-27 (scripts/lib/grammar-crosscheck.test.ts).

param(
  [Parameter(Mandatory = $true)][string]$AlcBin,
  # One absolute .al path per line, built by the caller from `corpusEntries()` so both parsers
  # read exactly the files the corpus fingerprint names (.dependencies excluded, R187).
  [Parameter(Mandatory = $true)][string]$ListFile
)

$ErrorActionPreference = "Stop"

$dll = Join-Path $AlcBin "Microsoft.Dynamics.Nav.CodeAnalysis.dll"
if (-not (Test-Path $dll)) { throw "not found: $dll" }
$asm = [System.Reflection.Assembly]::LoadFrom($dll)
$treeType = $asm.GetType("Microsoft.Dynamics.Nav.CodeAnalysis.Syntax.SyntaxTree")
if ($null -eq $treeType) { throw "SyntaxTree type not found in $dll" }

$files = @(Get-Content -LiteralPath $ListFile | Where-Object { $_ -ne "" } | ForEach-Object { Get-Item -LiteralPath $_ })

$out = New-Object System.Collections.Generic.List[object]
$parseErrorFiles = New-Object System.Collections.Generic.List[string]

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

  $root = $tree.GetRoot([System.Threading.CancellationToken]::None)
  foreach ($n in $root.DescendantNodes()) {
    $span = $n.Span
    # `parent` carries the context probes' answer (see CONTEXT_PROBES in al-kind-mapping.ts). A
    # node-kind comparison alone is blind to the statement_block class of regression, where the
    # nodes are all present at the same offsets and only their PARENT changed.
    $parentKind = if ($null -ne $n.Parent) { $n.Parent.Kind.ToString() } else { "" }
    $out.Add([pscustomobject]@{
      file   = $f.FullName
      kind   = $n.Kind.ToString()
      start  = $span.Start
      end    = $span.End
      parent = $parentKind
    })
  }
}

[pscustomobject]@{
  parserVersion   = $asm.GetName().Version.ToString()
  fileCount       = @($files).Count
  parseErrors     = $parseErrorFiles.Count
  parseErrorFiles = $parseErrorFiles
  nodes           = $out
} | ConvertTo-Json -Depth 4 -Compress
