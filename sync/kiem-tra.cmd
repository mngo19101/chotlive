@echo off
chcp 65001 >nul
cd /d "%~dp0.."
node --no-warnings sync\sync.js status
echo.
pause
