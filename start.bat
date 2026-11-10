@echo off
title ChannelScope
cd /d %~dp0
echo ========================================
echo  ChannelScope - YouTube Competitor Map
echo ========================================
echo.

where node >nul 2>nul
if %errorlevel% neq 0 (
  echo Node.js nahi mila!
  echo Pehle Node.js LTS install karo: https://nodejs.org
  echo (LTS version download karo, install karo, phir dobara start.bat chalao)
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Pehli dafa setup ho raha hai, dependencies install ho rahi hain...
  call npm install
  echo.
)

echo Server start ho raha hai...
echo Browser mein khud khul jayega: http://localhost:3000
echo Band karne ke liye is window mein Ctrl+C dabao.
echo.
start "" http://localhost:3000
node server.js
pause
