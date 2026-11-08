@echo off
rem Chay server ChotLive va tu bat lai neu server bi tat dot ngot.
rem Tac vu "ChotLive Server" goi file nay moi khi dang nhap Windows (xem cai-tu-chay-server.ps1).
rem Nhat ky: data\server.log
cd /d "%~dp0.."
if not exist data mkdir data

:loop
for %%F in (data\server.log) do if %%~zF GTR 5000000 move /y data\server.log data\server.old.log >nul
echo [%date% %time%] Khoi dong server>>data\server.log
call npm.cmd start >>data\server.log 2>&1
echo [%date% %time%] Server da dung, 10 giay nua chay lai>>data\server.log
rem Dung ping thay cho timeout vi timeout loi khi chay khong co cua so.
ping -n 11 127.0.0.1 >nul
goto loop
