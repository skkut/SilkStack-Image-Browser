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

Write-Host "Launching the application in dev mode (using dist files)..."
npx electron . --dist
