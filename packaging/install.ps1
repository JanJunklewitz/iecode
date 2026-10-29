<#
.SYNOPSIS
  Installs the iecode CLI for the current user (no admin rights needed).

.DESCRIPTION
  Downloads iecode-<version>-win-x64.zip from the GitHub release, checks it against SHA256SUMS,
  extracts it to %LOCALAPPDATA%\iecode and adds that folder to the user PATH.

  irm https://github.com/JanJunklewitz/iecode/releases/latest/download/install.ps1 | iex

.PARAMETER Version
  Release to install, e.g. 0.4.0. Default: latest.
#>
param(
  [string]$Version = 'latest',
  [string]$Repository = 'JanJunklewitz/iecode',
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'iecode')
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$base = if ($Version -eq 'latest') { "https://github.com/$Repository/releases/latest/download" }
        else { "https://github.com/$Repository/releases/download/v$($Version.TrimStart('v'))" }

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("iecode-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Write-Host "● Reading release $Version from ${Repository}…"
  # GitHub serves release assets as application/octet-stream, so .Content would be a byte array: read the file instead
  $sumsFile = Join-Path $tmp 'SHA256SUMS'
  Invoke-WebRequest "$base/SHA256SUMS" -OutFile $sumsFile -UseBasicParsing
  $sums = Get-Content $sumsFile | Where-Object { $_ -match 'iecode-.*-win-x64\.zip' }
  if (-not $sums) { throw "No win-x64 zip listed in SHA256SUMS of release $Version." }
  $hash, $zip = ($sums | Select-Object -First 1).Trim() -split '\s+', 2

  Write-Host "● Downloading ${zip}…"
  $file = Join-Path $tmp $zip
  Invoke-WebRequest "$base/$zip" -OutFile $file -UseBasicParsing
  $actual = (Get-FileHash $file -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $hash.ToLower()) { throw "Checksum mismatch for $zip (expected $hash, got $actual)." }
  Write-Host "● SHA256 ok"

  if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
  Expand-Archive $file -DestinationPath $InstallDir

  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (($userPath -split ';') -notcontains $InstallDir) {
    [Environment]::SetEnvironmentVariable('Path', ($userPath.TrimEnd(';') + ';' + $InstallDir).TrimStart(';'), 'User')
    Write-Host "● Added $InstallDir to the user PATH (open a new terminal)"
  }
  $env:Path = "$InstallDir;$env:Path"
  Write-Host "✔ $(& (Join-Path $InstallDir 'iecode.exe') --version) installed to $InstallDir — run 'iecode doctor' to check your setup" -ForegroundColor Green
}
finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
