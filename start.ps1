$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'bin\newagent.mjs') @args
exit $LASTEXITCODE
