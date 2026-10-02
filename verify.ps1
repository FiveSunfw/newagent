$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
& npm run verify
exit $LASTEXITCODE
