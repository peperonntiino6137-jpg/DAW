@echo off
rem ============================================================
rem  DAW stems sidecar launcher (self-contained)
rem
rem  What it does, in order:
rem    1. Creates a Python venv at %LOCALAPPDATA%\daw-stems-venv
rem       if it does not exist yet.
rem       -> The venv deliberately lives OUTSIDE the repo, at a short
rem          path. torch's header/library paths inside a venv get very
rem          deep and blow past the Windows MAX_PATH (260 chars) limit
rem          when the venv sits under a long directory. A short real
rem          path is simpler and more robust than the old junction
rem          workaround (see README.md).
rem    2. Installs demucs + numpy into the venv on first run.
rem       -> demucs 4.1.0 does NOT declare numpy as a dependency, so
rem          both must be named explicitly. First run downloads about
rem          700 MB (torch CPU included); the htdemucs model (~80 MB)
rem          is fetched automatically on the first separation.
rem    3. Starts sidecar.py on http://127.0.0.1:8787
rem
rem  Double-click this file, or run it from a terminal.
rem  Stop the server with Ctrl+C or by closing the window.
rem  (Messages are ASCII-only so they render in any console codepage.)
rem ============================================================
setlocal
set "VENV=%LOCALAPPDATA%\daw-stems-venv"
set "HERE=%~dp0"

rem ---- pick a Python interpreter --------------------------------------
set "PY_CMD=python"
%PY_CMD% -c "import sys" >nul 2>&1
if errorlevel 1 (
    set "PY_CMD=py -3"
    %PY_CMD% -c "import sys" >nul 2>&1
    if errorlevel 1 (
        echo [ERROR] Python not found. Install Python 3 and re-run.
        pause
        exit /b 1
    )
)

rem ---- create the venv (short path, MAX_PATH-safe) --------------------
if not exist "%VENV%\Scripts\python.exe" (
    echo [setup] creating venv at %VENV% ...
    %PY_CMD% -m venv "%VENV%"
    if errorlevel 1 (
        echo [ERROR] could not create venv at %VENV%
        pause
        exit /b 1
    )
)

rem ---- install demucs + numpy on first run ----------------------------
"%VENV%\Scripts\python.exe" -c "import demucs, numpy" >nul 2>&1
if errorlevel 1 (
    echo [setup] installing demucs + numpy - first run only, about 700 MB ...
    "%VENV%\Scripts\python.exe" -m pip install --upgrade pip
    "%VENV%\Scripts\python.exe" -m pip install demucs numpy
    if errorlevel 1 (
        echo [ERROR] pip install failed. Check network and retry.
        pause
        exit /b 1
    )
)

rem ---- start the server -----------------------------------------------
echo Starting stems sidecar on http://127.0.0.1:8787 ...
echo (first separation also downloads the htdemucs model, ~80 MB)
"%VENV%\Scripts\python.exe" "%HERE%sidecar.py"
pause
