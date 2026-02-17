$ErrorActionPreference = "Stop"

Write-Host "Clearing previous build artifacts..."
Remove-Item -Path "dist" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path "dist-electron" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path "release" -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "Building and Packaging with Electron Packager..."
# Specifically use electron-packager via the new script to avoid winCodeSign issues with electron-builder
npm run package-win

if ($LASTEXITCODE -ne 0) {
    Write-Error "Build/Package failed!"
    exit $LASTEXITCODE
}

Write-Host "Build complete! Artifacts are in release-builds directory."

