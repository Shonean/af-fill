@echo off
chcp 65001 >nul
cd /d %~dp0
echo [AF-Fill] starting workbench + driver + dedicated Edge profile...
python workbench.py
echo.
echo [AF-Fill] workbench exited. press any key to close.
pause >nul
