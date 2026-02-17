@echo off
echo Running production build (Manual Packaging)...
powershell -ExecutionPolicy Bypass -File build-prod.ps1
if %errorlevel% neq 0 (
    echo Build failed!
    exit /b %errorlevel%
)
echo Build success!
