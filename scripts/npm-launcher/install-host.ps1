# Installs the Dream host runtime (dream-host) for this Windows machine.
#
#   irm https://github.com/dreamide/dream/releases/download/v__DREAM_HOST_VERSION__/install-host.ps1 | iex
#
# It goes in %USERPROFILE%\.dream\host\versions\<version>\ (checked against
# the release's SHA256SUMS), and a dream-host command is put in
# %USERPROFILE%\.dream\bin, which is added to your user PATH.
# DREAM_HOST_VERSION chooses another version; DREAM_HOST_RELEASES_URL
# another download location.
# Built by scripts/build-host-installers.mjs.

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
# Windows PowerShell 5.1 does not offer TLS 1.2 unless asked.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$version = if ($env:DREAM_HOST_VERSION) { $env:DREAM_HOST_VERSION } else { "__DREAM_HOST_VERSION__" }
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
if ($arch -ne "x64") {
  throw "No Dream host runtime is built for windows-$arch. Supported on Windows: windows-x64."
}
$name = "dream-host-$version-windows-$arch.tar.gz"
$baseUrl = if ($env:DREAM_HOST_RELEASES_URL) { $env:DREAM_HOST_RELEASES_URL } else { "https://github.com/dreamide/dream/releases/download/v$version" }

$root = Join-Path $HOME ".dream\host\versions"
$dir = Join-Path $root $version
$marker = Join-Path $dir ".install-complete"

if (-not (Test-Path $marker)) {
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  $stage = Join-Path $root (".stage-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $stage | Out-Null
  try {
    Write-Host "Downloading the Dream host $version for windows-$arch..."
    $archive = Join-Path $stage $name
    $sums = Join-Path $stage "SHA256SUMS"
    Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/$name" -OutFile $archive
    Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/SHA256SUMS" -OutFile $sums

    $expected = $null
    foreach ($line in Get-Content $sums) {
      $fields = $line.Trim() -split "\s+"
      if ($fields.Count -ge 2 -and ($fields[1] -eq $name -or $fields[1] -eq "*$name")) {
        $expected = $fields[0].ToLowerInvariant()
      }
    }
    $actual = (Get-FileHash -Algorithm SHA256 -Path $archive).Hash.ToLowerInvariant()
    if (-not $expected -or $expected -ne $actual) {
      throw "The download of $name does not match its checksum; nothing was installed."
    }

    $runtime = Join-Path $stage "runtime"
    New-Item -ItemType Directory -Path $runtime | Out-Null
    # Windows' own tar (bsdtar), not one from another toolchain on PATH.
    & (Join-Path $env:SystemRoot "System32\tar.exe") -xzf $archive -C $runtime
    if ($LASTEXITCODE -ne 0) { throw "Could not unpack $name." }

    & (Join-Path $runtime "node\node.exe") (Join-Path $runtime "lib\dream-host.js") version | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "The Dream host $version does not run on this machine." }

    if (Test-Path $dir) { Remove-Item -Recurse -Force $dir }
    Move-Item -Path $runtime -Destination $dir
    New-Item -ItemType File -Path $marker | Out-Null
  }
  finally {
    Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
  }
}

$bin = Join-Path $HOME ".dream\bin"
New-Item -ItemType Directory -Force -Path $bin | Out-Null
$shim = Join-Path $bin "dream-host.cmd"
Set-Content -Path $shim -Encoding Ascii -Value "@`"$dir\bin\dream-host.cmd`" %*"

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$entries = if ($userPath) { $userPath -split ";" } else { @() }
if ($entries -notcontains $bin) {
  $next = if ($userPath) { "$bin;$userPath" } else { $bin }
  [Environment]::SetEnvironmentVariable("Path", $next, "User")
  $env:Path = "$bin;$env:Path"
  Write-Host "Added $bin to your user PATH; open a new terminal to use it there."
}
Write-Host "dream-host $version is installed as $shim."
