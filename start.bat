@echo off
rem Serves web\ at http://localhost:8080 (or the port given) and opens the browser.
rem Usage: start.bat [port]
setlocal
cd /d "%~dp0"

set "PORT=%~1"
if "%PORT%"=="" set "PORT=8080"

rem Prefer the Python launcher (py), fall back to python on PATH.
set "PY="
where py >nul 2>nul && set "PY=py -3"
if not defined PY (
    where python >nul 2>nul && set "PY=python"
)
if not defined PY (
    echo Python 3 is not installed. Get it from https://www.python.org/downloads/
    exit /b 1
)

rem Open the browser a moment after the server starts.
start "" /b cmd /c "timeout /t 1 /nobreak >nul & start "" http://localhost:%PORT%"
%PY% serve.py %PORT%
endlocal
