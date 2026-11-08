@echo off
chcp 65001 >nul
cd /d "%~dp0.."
set /p ADDR=Nhap ten may hoac IP cua mini PC (vi du 192.168.1.50):
node --no-warnings sync\sync.js set-peer "%ADDR%"
echo.
pause
