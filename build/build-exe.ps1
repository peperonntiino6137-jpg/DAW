# Build DAW.exe. No extra tools needed (uses Windows built-in csc.exe).
# Usage: powershell -ExecutionPolicy Bypass -File build\build-exe.ps1 [-NoModels] [-Out path]
#   -NoModels  skip stem-separation assets (vendor/ + models/, ~260MB). The exe still
#              runs; stem separation then asks the user to drop htdemucs_embedded.onnx.
#   -Out       output path (default: DAW.exe at repo root)
# NOTE: keep this file ASCII-only. PowerShell 5.1 reads BOM-less .ps1 as ANSI,
#       and multibyte comment bytes can swallow line breaks and break parsing.
param(
    [switch]$NoModels,
    [string]$Out
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
if (-not $Out) { $Out = "$root\DAW.exe" }
$csc = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"

# App files to embed (resource names are paths relative to index.html)
$files = @('index.html', 'style.css')
foreach ($js in (Get-ChildItem "$root\js" -Recurse -Filter *.js)) {
    $files += $js.FullName.Substring($root.Length + 1).Replace('\', '/')
}

# Stem separation assets: base64-embedded ort runtime (vendor/*.b64.js) and the
# htdemucs model chunks (models/htdemucs/*.js). Only the .js carriers are needed at
# runtime; raw binaries (.wasm/.mjs/.onnx) stay out of the exe.
if (-not $NoModels) {
    foreach ($dir in @('vendor', 'models')) {
        if (Test-Path "$root\$dir") {
            foreach ($f in (Get-ChildItem "$root\$dir" -Recurse -File)) {
                if ($f.Name -match '\.b64\.js$' -or $f.Name -eq 'manifest.js') {
                    $files += $f.FullName.Substring($root.Length + 1).Replace('\', '/')
                }
            }
        }
    }
}

$cscArgs = @('/nologo', '/target:winexe', "/out:$Out")
foreach ($f in $files) {
    $cscArgs += "/resource:$root\$($f.Replace('/', '\')),$f"
}
$cscArgs += "$PSScriptRoot\launcher.cs"

& $csc @cscArgs
if ($LASTEXITCODE -ne 0) { throw "csc failed" }
$mb = [math]::Round((Get-Item $Out).Length / 1MB, 1)
Write-Host "OK: $Out ($mb MB, $($files.Count) files embedded)"
