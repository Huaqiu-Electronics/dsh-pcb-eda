<#
.SYNOPSIS
    Package pcblint-local component for cloud distribution.

.OUTPUTS
    <outputDir>/pcblint-local-<version>.zip
    <outputDir>/pcblint-local-<version>.zip.sha256
    <outputDir>/pcblint-manifest.json

.PARAMETER Source
    Path to pcblint-local directory (must contain jre25/bin/java.exe and pcblint/pcblint.jar).

.PARAMETER Version
    Version string; if omitted reads <source>/pcblint/version.txt.

.PARAMETER Output
    Output directory, defaults to ./scripts/release relative to this script.

.PARAMETER ManifestUrl
    Zip download URL baked into manifest.json. Defaults to
    https://pcblint-cdn.huaqiu.cn/pcblint/pcblint-local-<version>.zip.

.PARAMETER MinKiCad
    Optional min KiCad version written into manifest.minKiCad.

.PARAMETER NoTopLevel
    Flatten zip root (jre25/ directly in zip). Default wraps one level
    so zip root contains pcblint-local/<content>. Both layouts are
    accepted by the downloader.
#>
param(
    [Parameter(Mandatory)]
    [string] $Source,

    [string] $Version,

    [string] $Output,

    [string] $ManifestUrl,

    [string] $MinKiCad = '',

    [switch] $NoTopLevel
)

# $PSScriptRoot is empty when called via powershell -File with a relative path;
# fall back to the directory of this script via $PSCommandPath.
$scriptPath = if ($PSCommandPath) { $PSCommandPath } else { $MyInvocation.MyCommand.Path }
$scriptDir = Split-Path -Parent $scriptPath
if (-not $Output) {
    $Output = Join-Path $scriptDir 'release'
}

$ErrorActionPreference = 'Stop'

$Source = [System.IO.Path]::GetFullPath($Source)
if (-not (Test-Path -LiteralPath $Source)) { throw "Source directory not found: $Source" }

# Resolve version
if (-not $Version) {
    $vt = Join-Path $Source 'pcblint\version.txt'
    if (Test-Path -LiteralPath $vt) {
        $Version = (Get-Content -LiteralPath $vt -Raw).Trim()
    }
}
if (-not $Version) {
    throw "Cannot determine version: pass -Version or write version into pcblint\version.txt"
}

# Verify component
$java = Join-Path $Source 'jre25\bin\java.exe'
$jar  = Join-Path $Source 'pcblint\pcblint.jar'
if (-not (Test-Path -LiteralPath $java)) { throw "Missing JRE: $java" }
if (-not (Test-Path -LiteralPath $jar))  { throw "Missing jar: $jar" }

# Write version.txt into component (ensures zip always carries it)
$versionFile = Join-Path $Source 'pcblint\version.txt'
[System.IO.File]::WriteAllText($versionFile, "$Version`r`n", [System.Text.Encoding]::ASCII)

New-Item -ItemType Directory -Force -Path $Output | Out-Null

$zipName = "pcblint-local-$Version.zip"
$zipPath = Join-Path $Output $zipName

# Clean old artifacts
Remove-Item -LiteralPath $zipPath -ErrorAction SilentlyContinue
Remove-Item -LiteralPath "$zipPath.sha256" -ErrorAction SilentlyContinue

# Compress
if ($NoTopLevel) {
    Compress-Archive -Path (Join-Path $Source '*') -DestinationPath $zipPath -CompressionLevel Optimal
} else {
    Compress-Archive -Path $Source -DestinationPath $zipPath -CompressionLevel Optimal
}

# SHA256
$sha = (certutil -hashfile $zipPath SHA256 | Select-Object -Index 1).Trim().ToLower()
[System.IO.File]::WriteAllText("$zipPath.sha256", $sha, [System.Text.Encoding]::ASCII)

# Manifest
if (-not $ManifestUrl) {
    $ManifestUrl = "https://pcblint-cdn.huaqiu.cn/pcblint/$zipName"
}
$manifest = [ordered]@{
    latest = $Version
    url    = $ManifestUrl
    sha256 = $sha
}
if ($MinKiCad) { $manifest.minKiCad = $MinKiCad }
$manifestJson = $manifest | ConvertTo-Json
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $Output 'pcblint-manifest.json'), $manifestJson, $utf8NoBom)

$zipSize = [math]::Round((Get-Item -LiteralPath $zipPath).Length / 1MB, 2)
Write-Host "release done:"
Write-Host "  version : $Version"
Write-Host "  zip     : $zipName ($zipSize MB)"
Write-Host "  sha256  : $sha"
Write-Host "  manifest: $(Join-Path $Output 'pcblint-manifest.json')"
