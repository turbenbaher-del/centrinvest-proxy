@echo off
REM Поднимает прокси ДБО через российский выход (RU-SOCKS должен уже работать на 127.0.0.1:10810 — он в автозагрузке).
set BANK_SOCKS=socks5://127.0.0.1:10810
cd /d "%~dp0"
echo Starting Centrinvest proxy via RU exit (BANK_SOCKS=%BANK_SOCKS%) ...
node server.js
