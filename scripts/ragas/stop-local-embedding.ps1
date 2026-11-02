$ErrorActionPreference = "Stop"
$processManifestPath = "E:\newagent\cache\ragas\embedding-services.json"
if (-not (Test-Path -LiteralPath $processManifestPath -PathType Leaf)) {
  Write-Output "No embedding services were started by the Ragas helper."
  exit 0
}
$tracked = @(Get-Content -LiteralPath $processManifestPath -Raw | ConvertFrom-Json)
foreach ($entry in $tracked) {
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($entry.processId)" -ErrorAction SilentlyContinue
  if (-not $process) { continue }
  $commandLine = [string]$process.CommandLine
  $expected = if ($entry.name -eq "qwen-embedding") { "embedding_server.py" } else { "local-embedding-cache.mjs" }
  if ($commandLine -notmatch [regex]::Escape($expected)) {
    Write-Warning "Skipping PID $($entry.processId): its command line no longer matches the tracked Ragas helper."
    continue
  }
  Stop-Process -Id $entry.processId -Force
}
Remove-Item -LiteralPath $processManifestPath -Force
Write-Output "Stopped only the embedding services launched by the Ragas helper."
