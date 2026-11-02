param(
  [ValidateRange(30, 1800)]
  [int]$WaitTimeoutSeconds = 600
)

$ErrorActionPreference = "Stop"
$newagentRoot = "E:\newagent"
$appRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$modelRoot = Join-Path $newagentRoot "data\embedding\model"
$manifestPath = Join-Path $newagentRoot "data\embedding\model-manifest.json"
$servicePath = Join-Path $newagentRoot "tools\embedding-service\embedding_server.py"
$logRoot = Join-Path $newagentRoot "cache\ragas\logs"
$processManifestPath = Join-Path $newagentRoot "cache\ragas\embedding-services.json"
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null

if (-not (Test-Path -LiteralPath $modelRoot -PathType Container) -or -not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  throw "Local Qwen3-Embedding-0.6B weights or manifest are missing under E:\newagent\data\embedding."
}
if (-not (Test-Path -LiteralPath $servicePath -PathType Leaf)) {
  throw "The existing local embedding service is missing: $servicePath"
}
$modelManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($modelManifest.model -ne "Qwen/Qwen3-Embedding-0.6B" -or $modelManifest.dimensions -and $modelManifest.dimensions -ne 1024) {
  throw "The local embedding model manifest does not match Qwen3-Embedding-0.6B/1024 dimensions."
}
$weightPath = Join-Path $modelRoot "model.safetensors"
if (-not (Test-Path -LiteralPath $weightPath -PathType Leaf)) { throw "Model weights are missing: model.safetensors" }
$weightHash = (Get-FileHash -LiteralPath $weightPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($weightHash -ne $modelManifest.weightsSha256) { throw "Qwen embedding weight SHA-256 does not match its E-drive manifest." }
$serviceHash = (Get-FileHash -LiteralPath $servicePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($serviceHash -ne $modelManifest.serviceSha256) { throw "The embedding service source does not match its E-drive manifest." }

$pythonExe = $env:NEWAGENT_EMBEDDING_PYTHON
if (-not $pythonExe) {
  $pythonCommand = Get-Command python.exe -ErrorAction SilentlyContinue
  if ($pythonCommand) { $pythonExe = $pythonCommand.Source }
}
if (-not $pythonExe -or -not (Test-Path -LiteralPath $pythonExe -PathType Leaf)) {
  throw "Set NEWAGENT_EMBEDDING_PYTHON to the existing Python that has torch, transformers, FastAPI and uvicorn installed. No dependencies were downloaded."
}
$runtimeCheck = & $pythonExe -c "import torch, transformers, fastapi, uvicorn; print('embedding-runtime-ok')" 2>&1
if ($LASTEXITCODE -ne 0 -or ($runtimeCheck -join "") -notmatch "embedding-runtime-ok") {
  throw "The selected Python cannot import the existing embedding-service dependencies; no downloads were attempted."
}

$started = @()
try { $embeddingHealth = Invoke-RestMethod -Uri "http://127.0.0.1:18091/health" -TimeoutSec 3 } catch { $embeddingHealth = $null }
if ($embeddingHealth) {
  if ($embeddingHealth.model -ne "Qwen/Qwen3-Embedding-0.6B" -or $embeddingHealth.device -ne "cpu" -or $embeddingHealth.dimensions -ne 1024) {
    throw "Port 18091 is occupied by an unexpected embedding service."
  }
} else {
  $stdout = Join-Path $logRoot "embedding-service.stdout.log"
  $stderr = Join-Path $logRoot "embedding-service.stderr.log"
  $environmentNames = @("NEWAGENT_HOME", "QWEN_EMBEDDING_MODEL_PATH", "QWEN_EMBEDDING_MODEL", "QWEN_EMBEDDING_MAX_LENGTH", "QWEN_EMBEDDING_PORT")
  $previousEnvironment = @{}
  foreach ($name in $environmentNames) { $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process") }
  $env:NEWAGENT_HOME = $newagentRoot
  $env:QWEN_EMBEDDING_MODEL_PATH = $modelRoot
  $env:QWEN_EMBEDDING_MODEL = "Qwen/Qwen3-Embedding-0.6B"
  $env:QWEN_EMBEDDING_MAX_LENGTH = "1024"
  $env:QWEN_EMBEDDING_PORT = "18091"
  try {
    $child = Start-Process -FilePath $pythonExe -ArgumentList @($servicePath) -WorkingDirectory $appRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
  } finally {
    foreach ($name in $environmentNames) { [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], "Process") }
  }
  $started += [pscustomobject]@{ name = "qwen-embedding"; processId = $child.Id }
}

try { $cacheHealth = Invoke-RestMethod -Uri "http://127.0.0.1:18092/health" -TimeoutSec 3 } catch { $cacheHealth = $null }
if (-not $cacheHealth) {
  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $nodeCommand) { throw "Node.js was not found; cannot start the existing E-drive embedding cache proxy." }
  $stdout = Join-Path $logRoot "embedding-cache.stdout.log"
  $stderr = Join-Path $logRoot "embedding-cache.stderr.log"
  $child = Start-Process -FilePath $nodeCommand.Source -ArgumentList @("scripts/local-embedding-cache.mjs") -WorkingDirectory $appRoot -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
  $started += [pscustomobject]@{ name = "embedding-cache"; processId = $child.Id }
}

$deadline = [DateTime]::UtcNow.AddSeconds($WaitTimeoutSeconds)
$ready = $false
while ([DateTime]::UtcNow -lt $deadline) {
  try {
    $embeddingHealth = Invoke-RestMethod -Uri "http://127.0.0.1:18091/health" -TimeoutSec 3
    $cacheHealth = Invoke-RestMethod -Uri "http://127.0.0.1:18092/health" -TimeoutSec 3
    if ($embeddingHealth.model -eq "Qwen/Qwen3-Embedding-0.6B" -and $embeddingHealth.dimensions -eq 1024 -and $cacheHealth.dimensions -eq 1024) {
      $ready = $true
      break
    }
  } catch { }
  Start-Sleep -Seconds 2
}
if (-not $ready) { throw "Local Qwen services did not become healthy within $WaitTimeoutSeconds seconds. Logs are under E:\newagent\cache\ragas\logs." }

$probe = Invoke-RestMethod -Uri "http://127.0.0.1:18092/v1/embeddings" -Method Post -ContentType "application/json" -Body (@{ model = "Qwen/Qwen3-Embedding-0.6B"; input = @("Ragas local embedding preflight") } | ConvertTo-Json -Compress) -TimeoutSec 240
if ($probe.data.Count -ne 1 -or $probe.data[0].embedding.Count -ne 1024) { throw "Local Qwen embedding preflight did not return a real 1024-dimensional vector." }

if ($started.Count -gt 0) {
  $saved = if (Test-Path -LiteralPath $processManifestPath) { @(Get-Content -LiteralPath $processManifestPath -Raw | ConvertFrom-Json) } else { @() }
  $saved += $started
  $saved | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $processManifestPath -Encoding utf8
}

[pscustomobject]@{
  embedding = "Qwen/Qwen3-Embedding-0.6B"
  device = "cpu"
  dimensions = 1024
  weights = "E:\newagent\data\embedding\model"
  vectorCache = "E:\newagent\cache\embedding\vectors-v1"
  servicesStarted = $started
  paidEmbeddingCalls = 0
} | ConvertTo-Json -Depth 5
