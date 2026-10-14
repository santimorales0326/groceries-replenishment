@echo off
title PantryPulse - Grocery Replenishment Tracker
echo Starting PantryPulse...

if not exist ".venv\Scripts\python.exe" (
    echo [ERROR] Virtual environment not found.
    echo Please create it by running:
    echo   python -m venv .venv
    echo   .\.venv\Scripts\pip install -r requirements.txt
    pause
    exit /b 1
)

.\.venv\Scripts\python.exe run.py
pause
