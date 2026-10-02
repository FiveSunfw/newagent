$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$env:NODE_USE_SYSTEM_CA = '1'
$env:NEWAGENT_ROOT = $taskRoot
$env:PI_CODING_AGENT_DIR = Join-Path $taskRoot 'data\pi'
$env:npm_config_cache = Join-Path $taskRoot 'cache\npm'
$env:TEMP = Join-Path $taskRoot 'cache\tmp'
$env:TMP = $env:TEMP
New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null
Set-Location $PSScriptRoot
& node dist/app-server/server.js
