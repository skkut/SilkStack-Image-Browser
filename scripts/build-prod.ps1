$ErrorActionPreference = "Stop"
Set-Location -Path "C:\Projects\AI-Images-Browser\"

Write-Host "Closing Running Application Instances..."
Get-Process -Name "SilkStack Image Browser" -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process -Name "ai-images-browser" -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process -Name "silkstack" -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process -Name "SilkStack" -ErrorAction SilentlyContinue | Stop-Process -Force


Write-Host "Clearing previous build artifacts..."
Remove-Item -Path "dist" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path "dist-electron" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path "release" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path "release-builds" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path "dist-packager" -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "Building and Packaging with Electron Packager..."
# Specifically use electron-packager via the new script to avoid winCodeSign issues with electron-builder
#
# Packaging budget. The `--ignore` in the package-win script is a ROOT ALLOWLIST:
# only electron/, dist/, public/, package.json, LICENSE and node_modules/ get
# packed. electron-packager has no allowlist of its own, and the previous
# partial blocklist let every stray repo-root directory through -- including
# gitignored ones nothing reads at runtime (ai-intelligence/, packages/, tmp/,
# scratch/, $target/, node_modules/.vite) -- producing a 726 MB / 17,014-file
# app.asar. That archive, not the compile, was what made packaging and deploy
# slow. The guard below fails the build if the archive creeps back up instead of
# silently shipping hundreds of megabytes again.
$MaxAsarMB = 120
npm run package-win

if ($LASTEXITCODE -ne 0) {
    Write-Error "Build/Package failed!"
    exit $LASTEXITCODE
}

Write-Host "Verifying package size..."
$BuildOutput = Get-ChildItem -Path "release-builds" -Directory | Select-Object -First 1
if ($null -eq $BuildOutput) {
    Write-Error "Could not find build output directory in release-builds!"
    exit 1
}

$AsarPath = Join-Path $BuildOutput.FullName "resources\app.asar"
if (!(Test-Path $AsarPath)) {
    Write-Error "Packaging produced no app.asar at $AsarPath"
    exit 1
}

$AsarMB = (Get-Item $AsarPath).Length / 1MB
$UnpackedPath = Join-Path $BuildOutput.FullName "resources\app.asar.unpacked"
$UnpackedMB = 0
if (Test-Path $UnpackedPath) {
    $UnpackedMB = (Get-ChildItem $UnpackedPath -Recurse -File | Measure-Object -Property Length -Sum).Sum / 1MB
}
Write-Host ("  app.asar: {0:N1} MB (budget {1} MB); app.asar.unpacked: {2:N1} MB" -f $AsarMB, $MaxAsarMB, $UnpackedMB)

if ($AsarMB -gt $MaxAsarMB) {
    Write-Error ("app.asar is {0:N1} MB, over the {1} MB budget -- something is being packed that should not ship. Check the --ignore allowlist in package.json, or raise the budget in this script deliberately." -f $AsarMB, $MaxAsarMB)
    exit 1
}

Write-Host "Deploying to C:\Programs\SilkStack Image Browser..."
$DestPath = "C:\Programs\SilkStack Image Browser"
if (!(Test-Path $DestPath)) {
    New-Item -ItemType Directory -Path $DestPath -Force | Out-Null
}

# /MIR mirrors the build output onto the destination: it copies only what changed
# and removes files no longer in the build. This replaces the old
# "Remove-Item the whole destination, then Copy-Item the whole source" pair,
# which rewrote the full ~1.1 GB tree (Electron runtime + asar) on every build;
# /MIR with /MT now rewrites only the changed archive.
# Robocopy exit codes 0-7 are success (1 = files copied, 2 = extra entries
# removed, ...) and 8+ are real failures, so the code is checked explicitly.
$nativeErrorPref = $PSNativeCommandUseErrorActionPreference
$PSNativeCommandUseErrorActionPreference = $false
& robocopy $BuildOutput.FullName $DestPath /MIR /MT:32 /R:1 /W:1 /NFL /NDL /NJH /NJS /NP
$roboExit = $LASTEXITCODE
$PSNativeCommandUseErrorActionPreference = $nativeErrorPref

if ($roboExit -ge 8) {
    Write-Error "robocopy failed with exit code $roboExit"
    exit 1
}

Write-Host "Build and Deployment complete! Artifacts are in $DestPath"

# Exit explicitly. A PowerShell script with no `exit` adopts the exit code of the
# last native command it ran -- and robocopy reports success as 1-7, so a fully
# successful build/deploy would otherwise report a nonzero status to the shell
# (and would throw if ever invoked via child_process.execSync).
exit 0
