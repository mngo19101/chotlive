@echo off
rem Bam dup de cai server tu chay khi dang nhap Windows.
rem Windows se hoi quyen Administrator de mo cong 3000 cho dien thoai.
powershell -NoProfile -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoExit','-NoProfile','-ExecutionPolicy','Bypass','-File','\"%~dp0cai-tu-chay-server.ps1\"'"
