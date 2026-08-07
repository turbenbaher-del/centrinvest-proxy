@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================================
echo   Локальный прокси ДБО Центр-инвест
echo ============================================================
echo.
echo Проверяю внешний IP (через что пойдёт трафик в банк)...
node -e "const https=require('https');https.get('https://api.ipify.org?format=json',r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{console.log('  Ваш внешний IP:',JSON.parse(d).ip)}catch(e){console.log('  не удалось определить IP')}})}).on('error',()=>console.log('  нет доступа в интернет'))"
echo.
echo Если IP НЕ российский — подключите Happ к серверу в России и запустите заново.
echo Если российский — всё готово.
echo.
echo Запускаю прокси на http://localhost:3001 ...
echo (остановить: Ctrl+C)
echo ============================================================
node server.js
pause
