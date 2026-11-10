@echo off
title NEON STRIKE server
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js topilmadi. https://nodejs.org dan LTS versiyani o'rnating. & pause & exit /b 1)
if not exist node_modules (echo Birinchi ishga tushirish: kutubxonalar o'rnatilmoqda... & call npm install)
echo.
echo Telefonda NEON STRIKE ilovasini oching va quyidagi LAN manzilni kiriting:
call npm start
pause
