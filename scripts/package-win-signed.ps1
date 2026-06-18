$ErrorActionPreference = "Stop"

function Require-Env {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name
  )

  $value = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw "Missing required environment variable: $Name"
  }

  return $value
}

function Resolve-CodeSignTool {
  function Assert-CodeSignToolPath {
    param(
      [Parameter(Mandatory = $true)]
      [string]$Path
    )

    $resolvedPath = (Resolve-Path -LiteralPath $Path).Path
    $fileName = Split-Path -Leaf $resolvedPath
    if ($fileName -notin @("CodeSignTool.bat", "CodeSignTool.exe")) {
      throw @"
SSL.com CodeSignTool path is not a CodeSignTool executable:
$resolvedPath

Set SSL_COM_CODESIGNTOOL in .env to the full path of CodeSignTool.bat or CodeSignTool.exe.
Example:
SSL_COM_CODESIGNTOOL=C:\Tools\CodeSignTool\CodeSignTool.bat
"@
    }

    return $resolvedPath
  }

  $configuredPath = [Environment]::GetEnvironmentVariable("SSL_COM_CODESIGNTOOL")
  if ([string]::IsNullOrWhiteSpace($configuredPath)) {
    throw "Missing required environment variable: SSL_COM_CODESIGNTOOL"
  }

  if (-not (Test-Path -LiteralPath $configuredPath)) {
    throw "SSL_COM_CODESIGNTOOL does not exist: $configuredPath"
  }

  return Assert-CodeSignToolPath $configuredPath
}

function Invoke-Step {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Title,
    [Parameter(Mandatory = $true)]
    [scriptblock]$Script
  )

  Write-Host ""
  Write-Host "==> $Title"
  $global:LASTEXITCODE = 0
  & $Script
  if ($LASTEXITCODE -ne 0) {
    throw "$Title failed with exit code $LASTEXITCODE"
  }
}

function Protect-CodeSignToolOutput {
  param(
    [AllowNull()]
    [object[]]$Output
  )

  if (-not $Output) {
    return @()
  }

  $secretsToRedact = @($username, $password, $credentialId, $totpSecret) |
    Where-Object { -not [string]::IsNullOrEmpty($_) }

  foreach ($line in $Output) {
    $redactedLine = [string]$line
    foreach ($secret in $secretsToRedact) {
      $redactedLine = $redactedLine.Replace($secret, "***")
    }

    $redactedLine
  }
}

function Invoke-CodeSignTool {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Title,
    [Parameter(Mandatory = $true)]
    [string]$InputPath,
    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory
  )

  Write-Host ""
  Write-Host "==> $Title"
  Write-Host "Using SSL.com CodeSignTool: $codeSignTool"
  Write-Host "Input: $InputPath"
  Write-Host "Output directory: $OutputDirectory"

  $logFileName = ($Title -replace "[^a-zA-Z0-9.-]+", "-").Trim("-").ToLowerInvariant()
  $logPath = Join-Path $buildReleaseDir "$logFileName.log"
  Write-Host "Log: $logPath"

  $global:LASTEXITCODE = 0
  $codeSignToolDirectory = Split-Path -Parent $codeSignTool
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  Push-Location $codeSignToolDirectory
  try {
    $output = & $codeSignTool sign `
      "-username=$username" `
      "-password=$password" `
      "-credential_id=$credentialId" `
      "-totp_secret=$totpSecret" `
      "-input_file_path=$InputPath" `
      "-output_dir_path=$OutputDirectory" `
      '-override=true' 2>&1
    $exitCode = $LASTEXITCODE
  } finally {
    Pop-Location
    $ErrorActionPreference = $previousErrorActionPreference
  }
  $redactedOutput = Protect-CodeSignToolOutput -Output $output
  $redactedOutput | Set-Content -LiteralPath $logPath
  $redactedOutput | ForEach-Object {
    Write-Host $_
  }

  if ($exitCode -ne 0) {
    throw "$Title failed with exit code $exitCode. See log: $logPath"
  }

  $inputName = Split-Path -Leaf $InputPath
  $exactOutput = Join-Path $OutputDirectory $inputName
  if (Test-Path -LiteralPath $exactOutput) {
    return $exactOutput
  }

  $signedOutput = Get-ChildItem -LiteralPath $OutputDirectory -Recurse -File |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

  if ($signedOutput) {
    return $signedOutput.FullName
  }

  $outputFiles = Get-ChildItem -LiteralPath $OutputDirectory -Recurse -Force -ErrorAction SilentlyContinue |
    ForEach-Object { $_.FullName }

  throw @"
SSL.com did not produce a signed output file.
Input: $InputPath
Output directory: $OutputDirectory
Log: $logPath
Files in output directory:
$($outputFiles -join [Environment]::NewLine)
"@
}

function Resolve-SignTool {
  $pathCommand = Get-Command "signtool.exe" -ErrorAction SilentlyContinue
  if ($pathCommand) {
    return $pathCommand.Source
  }

  $windowsKitsRoot = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
  if (-not (Test-Path -LiteralPath $windowsKitsRoot)) {
    return $null
  }

  $candidate = Get-ChildItem -LiteralPath $windowsKitsRoot -Recurse -File -Filter "signtool.exe" -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -like "*\x64\signtool.exe" } |
    Sort-Object FullName -Descending |
    Select-Object -First 1

  return $candidate?.FullName
}

function Assert-CodeSignature {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  try {
    Import-Module Microsoft.PowerShell.Security -ErrorAction Stop
    $signature = Get-AuthenticodeSignature -LiteralPath $Path -ErrorAction Stop
    $signature | Format-List
    if ($signature.Status -eq "Valid") {
      return
    }

    Write-Warning "Get-AuthenticodeSignature returned $($signature.Status). Trying signtool.exe verification."
  } catch {
    Write-Warning "Get-AuthenticodeSignature is unavailable: $($_.Exception.Message)"
  }

  $signTool = Resolve-SignTool
  if ($signTool) {
    $global:LASTEXITCODE = 0
    & $signTool verify /pa /v $Path
    if ($LASTEXITCODE -eq 0) {
      return
    }

    throw "signtool.exe verification failed for: $Path"
  }

  Write-Warning "Could not verify signature because neither Get-AuthenticodeSignature nor signtool.exe is available."
}

function Get-RunningPackagedAppProcess {
  if (-not (Test-Path -LiteralPath $unpackedDir)) {
    return @()
  }

  $normalizedUnpackedDir = [System.IO.Path]::GetFullPath($unpackedDir).TrimEnd("\")

  Get-CimInstance Win32_Process -Filter "name = 'Dream.exe'" |
    Where-Object {
      $_.ExecutablePath -and
      [System.IO.Path]::GetFullPath($_.ExecutablePath).StartsWith(
        $normalizedUnpackedDir,
        [System.StringComparison]::OrdinalIgnoreCase
      )
    }
}

function Stop-RunningPackagedAppProcesses {
  $runningProcesses = @(Get-RunningPackagedAppProcess)
  if ($runningProcesses.Count -gt 0) {
    Write-Host "Stopping previous packaged app instances from release\win-unpacked..."
    foreach ($process in $runningProcesses) {
      Write-Host "  $($process.Name) pid=$($process.ProcessId)"
      Stop-Process -Id $process.ProcessId -Force
    }

    Start-Sleep -Milliseconds 500

    $stillRunningProcesses = @(Get-RunningPackagedAppProcess)
    if ($stillRunningProcesses.Count -gt 0) {
      $processList = ($stillRunningProcesses | ForEach-Object {
        "$($_.Name) pid=$($_.ProcessId) path=$($_.ExecutablePath)"
      }) -join [Environment]::NewLine

      throw @"
Could not stop all previous packaged app instances from release\win-unpacked.
Close them before packaging again.

$processList
"@
    }
  }
}

function Assert-UnpackedDirIsWritable {
  Stop-RunningPackagedAppProcesses

  if (-not (Test-Path -LiteralPath $unpackedDir)) {
    return
  }

  try {
    Remove-Item -LiteralPath $unpackedDir -Recurse -Force
  } catch {
    throw @"
Could not clean release\win-unpacked before packaging.
Close any running Dream app or Explorer window that is using files in:
$unpackedDir

Original error: $($_.Exception.Message)
"@
  }
}

if ($env:OS -ne "Windows_NT") {
  throw "package:win:signed must be run on Windows."
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$releaseDir = Join-Path $repoRoot "release"
$buildId = Get-Date -Format "yyyyMMdd-HHmmss"
$buildReleaseDir = Join-Path $releaseDir "win-signed-build-$buildId"
$unpackedDir = Join-Path $buildReleaseDir "win-unpacked"
$signedAppDir = Join-Path $buildReleaseDir "signed-app"
$signedInstallerDir = Join-Path $buildReleaseDir "signed-installer"

function Import-EnvFile {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    return
  }

  foreach ($line in Get-Content -LiteralPath $Path) {
    $trimmed = $line.Trim()
    if ($trimmed.Length -eq 0 -or $trimmed.StartsWith("#")) {
      continue
    }

    $separatorIndex = $trimmed.IndexOf("=")
    if ($separatorIndex -le 0) {
      continue
    }

    $name = $trimmed.Substring(0, $separatorIndex).Trim()
    $value = $trimmed.Substring($separatorIndex + 1).Trim()
    if (
      ($value.StartsWith('"') -and $value.EndsWith('"')) -or
      ($value.StartsWith("'") -and $value.EndsWith("'"))
    ) {
      $value = $value.Substring(1, $value.Length - 2)
    }

    if (-not [string]::IsNullOrWhiteSpace($name)) {
      [Environment]::SetEnvironmentVariable($name, $value, "Process")
    }
  }
}

Import-EnvFile (Join-Path $repoRoot ".env")
Import-EnvFile (Join-Path $repoRoot ".env.local")

$codeSignTool = Resolve-CodeSignTool
$username = Require-Env "SSL_COM_USERNAME"
$password = Require-Env "SSL_COM_PASSWORD"
$credentialId = Require-Env "SSL_COM_CREDENTIAL_ID"
$totpSecret = Require-Env "SSL_COM_TOTP_SECRET"

$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
$env:HOME = Join-Path $repoRoot ".electron-home"

Set-Location $repoRoot

Invoke-Step "Build renderer" {
  pnpm vite:build
}

New-Item -ItemType Directory -Path $buildReleaseDir -Force | Out-Null

Invoke-Step "Package unpacked Windows app" {
  pnpm exec electron-builder --win dir --x64 "--config.directories.output=$buildReleaseDir" --config.win.signExecutable=false --publish never
}

$appExe = Join-Path $unpackedDir "Dream.exe"
if (-not (Test-Path -LiteralPath $appExe)) {
  throw "Could not find unpacked app executable: $appExe"
}

if (Test-Path -LiteralPath $signedAppDir) {
  Remove-Item -LiteralPath $signedAppDir -Recurse -Force
}
New-Item -ItemType Directory -Path $signedAppDir | Out-Null

$signedAppExe = Invoke-CodeSignTool `
  -Title "Sign unpacked app executable with SSL.com" `
  -InputPath $appExe `
  -OutputDirectory $signedAppDir
Copy-Item -LiteralPath $signedAppExe -Destination $appExe -Force

Invoke-Step "Verify signed app executable" {
  Assert-CodeSignature -Path $appExe
}

Invoke-Step "Package NSIS installer from signed app" {
  pnpm exec electron-builder --win nsis --x64 --prepackaged "$unpackedDir" "--config.directories.output=$buildReleaseDir" --config.win.signExecutable=false --publish never
}

$installer = Get-ChildItem -LiteralPath $buildReleaseDir -Filter "*.exe" -File |
  Where-Object { $_.FullName -ne $appExe -and $_.FullName -notlike "*\signed-*" } |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1

if (-not $installer) {
  throw "Could not find generated Windows installer in $buildReleaseDir"
}

if (Test-Path -LiteralPath $signedInstallerDir) {
  Remove-Item -LiteralPath $signedInstallerDir -Recurse -Force
}
New-Item -ItemType Directory -Path $signedInstallerDir | Out-Null

$signedInstaller = Invoke-CodeSignTool `
  -Title "Sign NSIS installer with SSL.com" `
  -InputPath $installer.FullName `
  -OutputDirectory $signedInstallerDir
Copy-Item -LiteralPath $signedInstaller -Destination $installer.FullName -Force
$finalInstaller = Join-Path $releaseDir $installer.Name
Copy-Item -LiteralPath $installer.FullName -Destination $finalInstaller -Force
Get-ChildItem -LiteralPath $buildReleaseDir -Filter "*.blockmap" -File |
  Copy-Item -Destination $releaseDir -Force

$latestYml = Join-Path $buildReleaseDir "latest.yml"
if (Test-Path -LiteralPath $latestYml) {
  Copy-Item -LiteralPath $latestYml -Destination $releaseDir -Force
}

Invoke-Step "Verify signed installer" {
  Assert-CodeSignature -Path $finalInstaller
}

Write-Host ""
Write-Host "Signed app: $appExe"
Write-Host "Signed installer: $finalInstaller"
