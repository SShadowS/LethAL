# Emit one JSON object per syntax node, from the AL compiler's OWN parser, for the issue #6 audit.
#
# `Microsoft.Dynamics.Nav.CodeAnalysis` ships inside the AL Language extension this repository
# already requires for `alc`, so this needs no new dependency. `ParseObjectText` is pure syntax:
# no symbols, no `.alpackages`, no project, which is why the audit can run per file.
#
# Usage:  pwsh -File dump-compiler-kinds.ps1 -AlcBin <dir> -Path <file-or-dir> > kinds.json
#
# Output is one JSON array of { file, kind, start, end }. Offsets are CHARACTER offsets into the
# file's text as .NET read it. That matches tree-sitter's byte offsets only for ASCII source, which
# is a known limit recorded beside the harness rather than papered over.

param(
  [Parameter(Mandatory = $true)][string]$AlcBin,
  [Parameter(Mandatory = $true)][string]$Path
)

$ErrorActionPreference = "Stop"

$dll = Join-Path $AlcBin "Microsoft.Dynamics.Nav.CodeAnalysis.dll"
if (-not (Test-Path $dll)) { throw "not found: $dll" }
$asm = [System.Reflection.Assembly]::LoadFrom($dll)
$treeType = $asm.GetType("Microsoft.Dynamics.Nav.CodeAnalysis.Syntax.SyntaxTree")
if ($null -eq $treeType) { throw "SyntaxTree type not found in $dll" }

$files = if (Test-Path $Path -PathType Container) {
  Get-ChildItem -Path $Path -Filter *.al -Recurse -File | Sort-Object FullName
} else {
  , (Get-Item $Path)
}

$out = New-Object System.Collections.Generic.List[object]
$parseErrors = 0

foreach ($f in $files) {
  $src = [System.IO.File]::ReadAllText($f.FullName)
  $tree = $treeType::ParseObjectText($src, $f.FullName, $null, $null, [System.Threading.CancellationToken]::None)
  if ($null -eq $tree) { $parseErrors++; continue }

  # A file the compiler cannot parse is reported rather than silently contributing zero nodes: an
  # empty result and a failed parse must not look alike.
  $errs = @($tree.GetDiagnostics([System.Threading.CancellationToken]::None)) |
    Where-Object { $_.Severity -eq "Error" }
  if ($errs.Count -gt 0) { $parseErrors++ }

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
  parserVersion = $asm.GetName().Version.ToString()
  fileCount     = @($files).Count
  parseErrors   = $parseErrors
  nodes         = $out
} | ConvertTo-Json -Depth 4 -Compress
