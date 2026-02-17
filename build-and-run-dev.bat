@echo off
echo Clearing previous build artifacts...
if exist "dist" rmdir /s /q "dist"
if exist "dist-electron" rmdir /s /q "dist-electron"
if exist "release" rmdir /s /q "release"

echo Building the project...
call npm run build
if %errorlevel% neq 0 (
    echo Build failed!
    exit /b %errorlevel%
)

echo Launching the application in dev mode (using dist files)...
call npx electron . --dist
