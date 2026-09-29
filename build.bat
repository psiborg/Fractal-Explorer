@echo off
rem Builds the Rust crate to WebAssembly and drops the JS bindings into web\libs\fractal.
rem Usage: build.bat          (release)
rem        build.bat --dev    (faster compile, bigger/slower output)
setlocal
cd /d "%~dp0"

where cargo >nul 2>nul
if errorlevel 1 (
    echo Rust is not installed. Get it from https://rustup.rs
    exit /b 1
)

where wasm-pack >nul 2>nul
if errorlevel 1 (
    echo wasm-pack is not installed. Run:
    echo     rustup target add wasm32-unknown-unknown
    echo     cargo install wasm-pack
    exit /b 1
)

set "PROFILE=--release"
if /i "%~1"=="--dev" set "PROFILE=--dev"

wasm-pack build %PROFILE% --target web --no-pack --out-dir web/libs/fractal
if errorlevel 1 (
    echo.
    echo Build failed.
    exit /b 1
)

echo.
echo Built. Run start.bat to serve it.
endlocal
