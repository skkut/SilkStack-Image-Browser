$ErrorActionPreference = "Stop"

Write-Host "Clearing previous build artifacts..."
Remove-Item -Path "dist" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path "dist-electron" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -Path "release" -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "Building the project..."
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Error "Build failed!"
    exit $LASTEXITCODE
}

Write-Host "Manual Packaging: Setting up directories..."
$releaseDir = "release\win-unpacked"
$appDir = "$releaseDir\resources\app"
New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null
New-Item -ItemType Directory -Path $appDir -Force | Out-Null

Write-Host "Manual Packaging: Copying Electron binaries..."
$electronDist = "node_modules\electron\dist"
if (-not (Test-Path $electronDist)) {
    Write-Error "Electron dist not found at $electronDist. Ensure dependencies are installed."
    exit 1
}
Copy-Item -Path "$electronDist\*" -Destination $releaseDir -Recurse -Force

Write-Host "Manual Packaging: Renaming executable..."
Rename-Item -Path "$releaseDir\electron.exe" -NewName "AI Images Browser.exe" -Force

Write-Host "Manual Packaging: Copying application files..."
Copy-Item -Path "package.json" -Destination $appDir
Copy-Item -Path "electron.mjs" -Destination $appDir
Copy-Item -Path "preload.js" -Destination $appDir
Copy-Item -Path "dist" -Destination $appDir -Recurse
Copy-Item -Path "services" -Destination $appDir -Recurse
Copy-Item -Path "public" -Destination $appDir -Recurse

Write-Host "Manual Packaging: Installing production dependencies..."
Push-Location $appDir
try {
    npm install --omit=dev
}
finally {
    Pop-Location
}

Write-Host "Compressing release..."
$zipPath = "release\AI-Images-Browser-Release.zip"
#Compress-Archive -Path "$releaseDir\*" -DestinationPath $zipPath -Force

Write-Host "Build complete! Artifacts:"
Write-Host " - Unpacked: $releaseDir"
Write-Host " - Zip: $zipPath"
