# R135 publish probe driver.
#
# Times the deployment step Option A of docs/roadmap/R135.md would pay PER MUTANT: compile an
# artifact whose only difference is one declarative property, then publish + sync + install it.
#
# Alternates between variant A (`const('A')` in the FlowField's CalcFormula) and variant B
# (`const('B')`), plus a NO-CHANGE control that republishes identical source under a new version, so
# the cost of the property change is separable from the cost of publishing at all.
#
# Run from the repo root:
#   pwsh -File scripts/r135-publish-probe/drive.ps1 -ContainerName Cronus281 -Rounds 3
#
# Leaves the probe UNPUBLISHED (see the -SkipCleanup switch to keep it for inspection).

param(
  [string]$ContainerName = 'Cronus281',
  [int]$Rounds = 3,
  [string]$User = 'sshadows',
  [string]$Password = '1234',
  [switch]$SkipCleanup
)

$ErrorActionPreference = 'Stop'
$env:DOCKER_CONTEXT = 'desktop-windows'

$probeDir = Join-Path $PSScriptRoot ''
$appJsonPath = Join-Path $probeDir 'app.json'
$probeTablePath = Join-Path $probeDir 'src\Probe.Table.al'
$alc = (Get-ChildItem "$env:USERPROFILE\.vscode\extensions\ms-dynamics-smb.al-*\bin\win32\alc.exe" |
  Sort-Object FullName | Select-Object -Last 1).FullName
if (-not $alc) { throw 'alc.exe not found under the AL VS Code extension' }

$securePassword = ConvertTo-SecureString $Password -AsPlainText -Force
$credential = New-Object System.Management.Automation.PSCredential($User, $securePassword)

$appName = 'LethAL R135 Publish Probe'
$results = @()
$build = 0

function Set-Variant([string]$Letter) {
  $src = Get-Content $probeTablePath -Raw
  $updated = [regex]::Replace($src, "const\('[A-Z]'\)", "const('$Letter')")
  Set-Content -Path $probeTablePath -Value $updated -NoNewline
}

# Option B of R135 restricts declarative mutations to "schema-neutral rewrites only, so ForceSync
# stays cheap". That premise needs testing, not assuming: this adds or removes an ordinary stored
# field, which is a REAL schema change, so the two can be compared against the same publish path.
$EXTRA_FIELD = @"

        field(3; "Schema Probe Field"; Decimal) { DataClassification = CustomerContent; }
"@

function Set-SchemaVariant([bool]$WithExtraField) {
  $src = Get-Content $probeTablePath -Raw
  $hasField = $src -match 'Schema Probe Field'
  if ($WithExtraField -and -not $hasField) {
    $src = $src -replace '(?s)(\s+Editable = false;\r?\n\s+\}\r?\n)', "`$1$EXTRA_FIELD`r`n"
  } elseif (-not $WithExtraField -and $hasField) {
    $src = [regex]::Replace($src, '\r?\n\s*field\(3; "Schema Probe Field".*?\r?\n', "`r`n")
  }
  Set-Content -Path $probeTablePath -Value $src -NoNewline
}

function Set-Version([string]$Version) {
  $json = Get-Content $appJsonPath -Raw
  $updated = [regex]::Replace($json, '"version": "[^"]+"', "`"version`": `"$Version`"")
  Set-Content -Path $appJsonPath -Value $updated -NoNewline
}

function Invoke-Round([string]$Label, [string]$Letter) {
  $script:build++
  $version = "1.0.0.$script:build"
  Set-Variant $Letter
  Set-Version $version
  $out = Join-Path $probeDir "r135-probe.app"
  if (Test-Path $out) { Remove-Item $out -Force }

  $compileSw = [System.Diagnostics.Stopwatch]::StartNew()
  & $alc "/project:$probeDir" "/packagecachepath:$probeDir\.alpackages" "/out:$out" | Out-Null
  $compileSw.Stop()
  if (-not (Test-Path $out)) { throw "compile produced no app for $Label" }

  $publishSw = [System.Diagnostics.Stopwatch]::StartNew()
  Publish-BcContainerApp -containerName $ContainerName -appFile $out -credential $credential `
    -useDevEndpoint -syncMode ForceSync -skipVerification -install | Out-Null
  $publishSw.Stop()

  $row = [pscustomobject]@{
    label     = $Label
    version   = $version
    variant   = $Letter
    compileMs = [int]$compileSw.Elapsed.TotalMilliseconds
    publishMs = [int]$publishSw.Elapsed.TotalMilliseconds
  }
  $script:results += $row
  Write-Host ("{0,-22} v{1,-8} variant {2}  compile {3,6} ms  publish+sync+install {4,7} ms" -f `
      $row.label, $row.version, $row.variant, $row.compileMs, $row.publishMs)
}

Write-Host "R135 publish probe against $ContainerName"
Write-Host (Invoke-ScriptInBcContainer -containerName $ContainerName -scriptblock {
    (Get-NAVServerInstance | Select-Object -First 1).Version
  })

# Cold first publish, reported separately: a first publish also creates the extension's schema and
# is not the marginal cost Option A would pay.
Invoke-Round 'cold-first-publish' 'A'

for ($i = 1; $i -le $Rounds; $i++) {
  Invoke-Round "property-changed-$i" $(if ($i % 2 -eq 1) { 'B' } else { 'A' })
  Invoke-Round "no-change-control-$i" $(if ($i % 2 -eq 1) { 'B' } else { 'A' })
}

# Option B's premise, measured against the same publish path.
for ($i = 1; $i -le $Rounds; $i++) {
  Set-SchemaVariant $true
  Invoke-Round "schema-add-field-$i" 'A'
  Set-SchemaVariant $false
  Invoke-Round "schema-drop-field-$i" 'A'
}

Write-Host ''
Write-Host 'SUMMARY'
$results | Format-Table -AutoSize | Out-String | Write-Host
$changed = $results | Where-Object { $_.label -like 'property-changed-*' }
$control = $results | Where-Object { $_.label -like 'no-change-control-*' }
function Median([int[]]$Values) {
  $sorted = $Values | Sort-Object
  if ($sorted.Count -eq 0) { return 0 }
  return $sorted[[int][math]::Floor($sorted.Count / 2)]
}
$schema = $results | Where-Object { $_.label -like 'schema-*' }
Write-Host ("property-changed   publish median {0} ms  (n={1})" -f (Median $changed.publishMs), $changed.Count)
Write-Host ("no-change control  publish median {0} ms  (n={1})" -f (Median $control.publishMs), $control.Count)
Write-Host ("schema-changed     publish median {0} ms  (n={1})" -f (Median $schema.publishMs), $schema.Count)
Write-Host ("compile median {0} ms over all rounds" -f (Median $results.compileMs))

# Leave variant A, two fields, in the tree so the committed source is the one the README describes.
Set-SchemaVariant $false
Set-Variant 'A'
Set-Version '1.0.0.1'

if (-not $SkipCleanup) {
  Write-Host ''
  Write-Host 'unpublishing the probe'
  UnPublish-BcContainerApp -containerName $ContainerName -name $appName -unInstall -doNotSaveData -force
  # The schema ghost: unpublishing leaves the tenant's synced schema behind, and the next publish
  # compares against it. Clean it while the app is UNPUBLISHED — see the al-probe skill.
  Invoke-ScriptInBcContainer -containerName $ContainerName -scriptblock {
    param($n)
    try { Sync-NAVApp -ServerInstance BC -Name $n -Mode Clean -Force } catch { Write-Host "clean-sync: $_" }
  } -argumentList $appName
}
