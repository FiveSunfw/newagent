param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("mitt-wildcard", "stringify-nonfinite", "dlv-falsy-values")]
  [string]$CaseId,
  [string]$Batch = "single-case-diagnostic-v1",
  [ValidateSet("newagent-qwen3-1.7b", "deepseek-flash")]
  [string]$Model = "newagent-qwen3-1.7b",
  [ValidateRange(0.0, 1.0)]
  [double]$TopP = 1.0,
  [ValidateSet(4096, 8192, 32768)]
  [int]$ContextWindow = 32768
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($Batch -notmatch "^single-case-diagnostic-v[1-9][0-9]*$") {
  throw "Batch must look like single-case-diagnostic-v1"
}

$env:NEWAGENT_EVAL_DATASET_VERSION = "v2"
$env:NEWAGENT_EVAL_BATCH = $Batch
$env:NEWAGENT_EVAL_MODEL = $Model
$env:NEWAGENT_EVAL_TOP_P = $TopP.ToString(
  [Globalization.CultureInfo]::InvariantCulture
)
$env:NEWAGENT_EVAL_CONTEXT_WINDOW = "$ContextWindow"
if ($Model -eq "deepseek-flash") {
  if (-not $env:DEEPSEEK_API_KEY) {
    throw "DeepSeek comparison requires the existing DEEPSEEK_API_KEY environment variable"
  }
  $env:NODE_OPTIONS = "--use-system-ca --use-env-proxy"
}
npm run eval:local:single-case -- $CaseId
exit $LASTEXITCODE
