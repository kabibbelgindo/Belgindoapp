@echo off
setlocal
cd /d "%~dp0"
title PT. BELGINDO RAYA INVENTORY
where py >nul 2>&1
if %errorlevel%==0 (
  py app.py %*
) else (
  python app.py %*
)
echo.
echo Server berhenti. Tekan tombol apa saja untuk menutup jendela.
pause >nul
