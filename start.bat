@echo off
cd /d %~dp0
echo ==========================================
echo  Installing / updating required packages...
echo ==========================================
call npm install
if errorlevel 1 (
    echo.
    echo npm install failed. Check your internet connection or Node.js install.
    pause
    exit /b 1
)
echo.
echo ==========================================
echo  Starting the bot...
echo ==========================================
node index.js
pause
