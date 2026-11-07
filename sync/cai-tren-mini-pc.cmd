@echo off
rem Bam dup tren mini PC. Windows se hoi quyen Administrator de mo cong dong bo.
powershell -NoProfile -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoExit','-NoProfile','-ExecutionPolicy','Bypass','-File','\"%~dp0install.ps1\"','-Role','hub'"
