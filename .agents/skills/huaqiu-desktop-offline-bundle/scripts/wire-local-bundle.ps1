param(
  [string]$HarnessRepo = 'C:\code\deepseek-harness',
  [string]$Ledger,
  [string]$WorkspaceFile,
  [switch]$Check
)

# Point every `@huaqiu/*` resolution in the harness workspace at the local
# tarballs produced by pack-product-packages.ps1, so the Desktop build resolves
# the product bundle from disk instead of npm.
#
# The block is delimited by marker comments derived from ledger.json, so re-running
# the script after a version bump replaces the block instead of duplicating it,
# and `-Check` reports drift without touching the file.

$ErrorActionPreference = 'Stop'

$HarnessRepo = (Resolve-Path -LiteralPath $HarnessRepo).Path
if (-not $WorkspaceFile) { $WorkspaceFile = Join-Path $HarnessRepo 'pnpm-workspace.yaml' }
if (-not $Ledger) { $Ledger = Join-Path $HarnessRepo 'product\huaqiu\ledger.json' }

$BEGIN = '# >>> local-huaqiu-bundle (generated from product/huaqiu/ledger.json)'
$END = '# <<< local-huaqiu-bundle'

$ledgerData = Get-Content -LiteralPath $Ledger -Raw | ConvertFrom-Json
$records = @($ledgerData.packages)
if ($records.Count -eq 0) { throw "ledger has no packages: $Ledger" }

foreach ($record in $records) {
  $tarball = Join-Path (Join-Path $HarnessRepo 'product\huaqiu') $record.file
  if (-not (Test-Path -LiteralPath $tarball)) { throw "missing tarball for $($record.name): $tarball" }
}

$block = @($BEGIN)
foreach ($record in ($records | Sort-Object name)) {
  $spec = "file:./product/huaqiu/$($record.file)"
  $block += "  '$($record.name)': '$spec'"
}
$block += $END
$blockText = ($block -join "`n")

$content = Get-Content -LiteralPath $WorkspaceFile -Raw
$pattern = "(?s)$([regex]::Escape($BEGIN)).*?$([regex]::Escape($END))"

if ($content -match $pattern) {
  $updated = [regex]::Replace($content, $pattern, $blockText.Replace('$', '$$'), 1)
} elseif ($content -match '(?m)^overrides:\s*$') {
  $updated = $content -replace '(?m)^overrides:\s*$', ("overrides:`n" + $blockText)
} else {
  $updated = $content.TrimEnd() + "`n`noverrides:`n" + $blockText + "`n"
}

# Keep the bundle version honest: an apps/cli spec that disagrees with the
# tarball version is the difference between a working closure and
# "packed inputs omit required package".
$cliManifest = Join-Path $HarnessRepo 'apps\cli\package.json'
$cliText = Get-Content -LiteralPath $cliManifest -Raw
foreach ($record in @($records | Where-Object { $_.name -eq '@huaqiu/hardware-engineering' -or $_.name -eq '@huaqiu/component-gen-app' })) {
  $declared = [regex]::Match($cliText, '"' + [regex]::Escape($record.name) + '":\s*"([^"]+)"')
  $expected = '"' + $record.name + '": "' + $record.version + '"'
  if ($declared.Success -and $declared.Value -ne $expected) {
    Write-Host ("apps/cli: {0} declares {1}, ledger has {2} — update it by hand" -f $record.name, $declared.Groups[1].Value, $record.version)
  } elseif (-not $declared.Success) {
    Write-Host ("apps/cli: {0} is not declared — add it by hand as a dependency at {1}" -f $record.name, $record.version)
  }
}

if ($Check) {
  if ($updated -eq $content) { Write-Host 'workspace overrides: up to date' ; return }
  Write-Host 'workspace overrides: DRIFT (rerun without -Check to apply)'
  exit 1
}

if ($updated -eq $content) {
  Write-Host ("workspace overrides: already current ({0} packages)" -f $records.Count)
  return
}

$backup = "$WorkspaceFile.bak"
Copy-Item -LiteralPath $WorkspaceFile -Destination $backup -Force
Set-Content -LiteralPath $WorkspaceFile -Value $updated -Encoding utf8 -NoNewline
Write-Host ("workspace overrides: wrote {0} entries into {1} (backup {2})" -f $records.Count, $WorkspaceFile, $backup)
