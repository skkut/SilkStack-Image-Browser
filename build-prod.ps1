$ErrorActionPreference = "Stop"
Write-Host "Closing Running Application Instances..."
Get-Process -Name "AI Images Browser" -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process -Name "ai-images-browser" -ErrorAction SilentlyContinue | Stop-Process -Force


Write-Host "Clearing previous build artifacts..."
Remove-Item -Path "dist" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path "dist-electron" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path "release" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path "release-builds" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path "dist-packager" -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "Building and Packaging with Electron Packager..."
# Specifically use electron-packager via the new script to avoid winCodeSign issues with electron-builder
npm run package-win

if ($LASTEXITCODE -ne 0) {
    Write-Error "Build/Package failed!"
    exit $LASTEXITCODE
}



Write-Host "Deploying to C:\Programs\AI Images Browser..."
$BuildOutput = Get-ChildItem -Path "release-builds" -Directory | Select-Object -First 1
if ($null -eq $BuildOutput) {
    Write-Error "Could not find build output directory in release-builds!"
    exit 1
}

$DestPath = "C:\Programs\AI Images Browser"
if (!(Test-Path $DestPath)) {
    New-Item -ItemType Directory -Path $DestPath -Force
}

Copy-Item -Path "$($BuildOutput.FullName)\*" -Destination $DestPath -Recurse -Force

Write-Host "Build and Deployment complete! Artifacts are in $DestPath"
