param(
  [string]$Repo = 'C:\code\dsh-pcb-eda',
  [string]$Bundle = '@huaqiu/hardware-engineering',
  [string]$OutDir,
  [string]$Pnpm,
  [switch]$Install,
  [switch]$DryRun
)

# Pack the workspace closure rooted at the product bundle into standalone .tgz
# files + a ledger, for a Desktop build that must NOT depend on npm.
#
# The closure is computed, not hardcoded: every workspace package reachable from
# the bundle through dependencies / peerDependencies / optionalDependencies. That
# is what makes a version bump (0.7.10 -> 0.7.11) a no-op for this script, and
# why `@huaqiu/component-gen-app` (a peer of dsh-tool-symbol-footprint) is
# included instead of silently missing from the runtime closure later.
#
# `pnpm pack` runs each package's `prepack` (tsdown), so the tarballs carry
# freshly built `lib/` — a stale build cannot leak into the installer.

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath (Join-Path $Repo 'pnpm-workspace.yaml'))) {
  throw "not a pnpm workspace: $Repo"
}

if (-not $OutDir) {
  $OutDir = Join-Path $Repo 'product\huaqiu'
}

function Resolve-Pnpm {
  if ($Pnpm) { return $Pnpm }
  if ($env:DSH_PNPM) { return $env:DSH_PNPM }
  $cmd = Get-Command pnpm -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) {
    $candidate = 'C:\node\node.exe'
    if (Test-Path -LiteralPath $candidate) { $node = Get-Item -LiteralPath $candidate }
  }
  $entries = @(
    (Join-Path $Repo 'node_modules\pnpm\bin\pnpm.mjs'),
    (Join-Path (Split-Path -Parent $Repo) 'deepseek-harness\node_modules\pnpm\bin\pnpm.mjs')
  )
  foreach ($entry in $entries) {
    if ((Test-Path -LiteralPath $entry) -and $node) { return "$($node.Source) $entry" }
  }
  throw 'pnpm not found: put it on PATH, set $env:DSH_PNPM, or pass -Pnpm'
}

$pnpmCommand = Resolve-Pnpm
$pnpmParts = $pnpmCommand -split ' ', 2

# `pnpm pack` runs each package's `prepack` ("pnpm build") through npm lifecycle,
# which spawns cmd.exe and therefore resolves pnpm from PATH — not from this
# process' call. Without a real pnpm on PATH the pack fails with
# "'pnpm' is not recognized". Materialize a shim and prepend it.
if ($pnpmParts.Length -gt 1) {
  $shimDir = Join-Path ([System.IO.Path]::GetTempPath()) 'hq-offline-bundle-bin'
  New-Item -ItemType Directory -Path $shimDir -Force | Out-Null
  $shim = '@echo off' + "`r`n" + '"' + $pnpmParts[0] + '" "' + $pnpmParts[1] + '" %*' + "`r`n"
  Set-Content -LiteralPath (Join-Path $shimDir 'pnpm.cmd') -Value $shim -Encoding ascii -NoNewline
  $env:Path = "$shimDir;$env:Path"
}

function Invoke-Pnpm {
  param([string[]]$Arguments, [string]$WorkingDirectory)
  $parts = $pnpmCommand -split ' ', 2
  $exe = $parts[0]
  # Force an array: splatting a bare string enumerates its characters, which
  # turns "C:\...\pnpm.mjs" into node arguments "C", ":", ... .
  [string[]]$prefix = if ($parts.Length -gt 1) { $parts[1] -split ' ' } else { @() }
  Push-Location $WorkingDirectory
  try {
    if ($env:DSH_PACK_DEBUG) { Write-Host ("exec: {0} {1} {2}" -f $exe, ($prefix -join '|'), ($Arguments -join '|')) }
    # Out-Host keeps pnpm's chatter off the pipeline: this function is called
    # inside `$records = foreach (...)`, and bare output would be captured into
    # the ledger as thousands of junk entries.
    & $exe @prefix @Arguments | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "pnpm exited with $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
}

# name -> { dir, manifest }
$packages = @{}
Get-ChildItem -LiteralPath (Join-Path $Repo 'packages') -Directory | ForEach-Object {
  $manifestPath = Join-Path $_.FullName 'package.json'
  if (-not (Test-Path -LiteralPath $manifestPath)) { return }
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  if ($manifest.name) {
    $packages[$manifest.name] = [pscustomobject]@{ dir = $_.FullName; manifest = $manifest }
  }
}

if (-not $packages.ContainsKey($Bundle)) { throw "bundle package not found in workspace: $Bundle" }

$closure = [System.Collections.Generic.List[string]]::new()
$seen = @{}
$queue = [System.Collections.Generic.Queue[string]]::new()
$queue.Enqueue($Bundle)
while ($queue.Count -gt 0) {
  $name = $queue.Dequeue()
  if ($seen.ContainsKey($name)) { continue }
  $seen[$name] = $true
  if (-not $packages.ContainsKey($name)) { continue } # external / workspace-excluded
  $closure.Add($name)
  $manifest = $packages[$name].manifest
  foreach ($section in 'dependencies', 'peerDependencies', 'optionalDependencies') {
    $block = $manifest.$section
    if ($null -eq $block) { continue }
    foreach ($dep in $block.PSObject.Properties.Name) {
      if ($packages.ContainsKey($dep) -and -not $seen.ContainsKey($dep)) { $queue.Enqueue($dep) }
    }
  }
}

$ordered = $closure | Sort-Object
Write-Host ("closure: {0} workspace packages rooted at {1}" -f $ordered.Count, $Bundle)
$ordered | ForEach-Object { Write-Host ("  {0,-45} {1}" -f $_, $packages[$_].manifest.version) }

if ($DryRun) { return }

# `pnpm pack` rewrites `workspace:*` into concrete versions by reading the
# *installed* workspace graph; with an un-installed (or partially installed) tree
# it aborts with ERR_PNPM_CANNOT_RESOLVE_WORKSPACE_PROTOCOL on that one package,
# after the earlier tarballs were already written.
$installed = Test-Path -LiteralPath (Join-Path $Repo 'node_modules\.pnpm')
# A present .pnpm store is not proof the bundle's own dependency links exist:
# a partially installed tree also aborts on the workspace-protocol rewrite.
$bundleEntry = $packages[$Bundle]
$bundleManifest = $bundleEntry.manifest
foreach ($section in 'dependencies', 'peerDependencies') {
  $block = $bundleManifest.$section
  if ($null -eq $block) { continue }
  foreach ($dep in $block.PSObject.Properties.Name) {
    if (-not $packages.ContainsKey($dep)) { continue }
    $link = Join-Path (Join-Path $bundleEntry.dir 'node_modules') ($dep -replace '/', '\')
    if (-not (Test-Path -LiteralPath $link)) { $installed = $false }
  }
}
if (-not $installed) {
  if (-not $Install) {
    throw "workspace not installed: run '$pnpmCommand install --frozen-lockfile' in $Repo (or pass -Install)"
  }
  Write-Host 'installing workspace ...'
  Invoke-Pnpm -WorkingDirectory $Repo -Arguments @('install', '--frozen-lockfile')
}

New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
Get-ChildItem -LiteralPath $OutDir -Filter '*.tgz' | Remove-Item -Force

$records = foreach ($name in $ordered) {
  $entry = $packages[$name]
  Write-Host ("packing {0} ..." -f $name)
  Invoke-Pnpm -WorkingDirectory $entry.dir -Arguments @('pack', '--pack-destination', $OutDir)
  $file = Get-ChildItem -LiteralPath $OutDir -Filter '*.tgz' |
    Where-Object { $_.LastWriteTime -gt (Get-Date).AddSeconds(-30) } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if (-not $file) { throw "no tarball produced for $name" }
  $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  [pscustomobject][ordered]@{
    name = $name
    version = $entry.manifest.version
    file = $file.Name
    bytes = $file.Length
    sha256 = $hash
  }
}

$bundleVersion = $packages[$Bundle].manifest.version
$ledger = [ordered]@{
  schemaVersion = 1
  source = 'dsh-pcb-eda workspace closure'
  bundle = $Bundle
  bundleVersion = $bundleVersion
  generatedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  packages = $records
}
$ledgerPath = Join-Path $OutDir 'ledger.json'
($ledger | ConvertTo-Json -Depth 6) + "`n" | Set-Content -LiteralPath $ledgerPath -Encoding utf8

Write-Host ''
Write-Host ("packed {0} tarballs into {1}" -f $records.Count, $OutDir)
Write-Host ("bundle version: {0} (pin apps/cli to this exact version)" -f $bundleVersion)
Write-Host ("ledger: {0}" -f $ledgerPath)
$records | Format-Table name, version, file, bytes -AutoSize
