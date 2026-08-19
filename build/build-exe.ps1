# Build DAW.exe. No extra tools needed (uses Windows built-in csc.exe).
# Usage: powershell -ExecutionPolicy Bypass -File build\build-exe.ps1
# NOTE: keep this file ASCII-only. PowerShell 5.1 reads BOM-less .ps1 as ANSI,
#       and multibyte comment bytes can swallow line breaks and break parsing.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
$csc = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"

# App files to embed (resource names are paths relative to index.html)
$files = @('index.html', 'style.css')
foreach ($js in (Get-ChildItem "$root\js" -Recurse -Filter *.js)) {
    $files += $js.FullName.Substring($root.Length + 1).Replace('\', '/')
}

$cscArgs = @('/nologo', '/target:winexe', "/out:$root\DAW.exe")
foreach ($f in $files) {
    $cscArgs += "/resource:$root\$($f.Replace('/', '\')),$f"
}
$cscArgs += "$PSScriptRoot\launcher.cs"

& $csc @cscArgs
if ($LASTEXITCODE -ne 0) { throw "csc failed" }
$kb = [math]::Round((Get-Item "$root\DAW.exe").Length / 1KB)
Write-Host "OK: $root\DAW.exe ($kb KB, $($files.Count) files embedded)"
