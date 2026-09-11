$ErrorActionPreference = 'Stop'
# Avoid loading incompatible PowerShell 7 modules inherited through Node.
$env:PSModulePath = [System.IO.Path]::Combine($PSHOME, 'Modules')
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$roots = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
)
$versions = @($roots | Where-Object { Test-Path $_ } | ForEach-Object {
    Get-ChildItem -LiteralPath $_ | Get-ItemProperty | Where-Object {
        $_.DisplayName -match '^ZCode(?:\s|$)' -and $_.DisplayVersion -match '^3\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$'
    } | Select-Object -ExpandProperty DisplayVersion
} | Sort-Object -Unique)
if ($versions.Count -eq 1) { [Console]::Out.Write($versions[0]) }
