param(
  [Parameter(Mandatory = $true)]
  [ValidateSet(
    "mitt-wildcard",
    "mitt-unknown-handler",
    "stringify-nonfinite",
    "stringify-array-holes",
    "dlv-falsy-values",
    "dlv-array-path"
  )]
  [string]$CaseId,
  [string]$Batch = "",
  [ValidateSet("single-no-rag", "single-rag")]
  [string]$Strategy = "single-no-rag",
  [ValidateRange(4096, 262144)]
  [int]$ContextWindow = 262144
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($env:NEWAGENT_API_KEY)) {
  throw "NEWAGENT_API_KEY is not visible to this process. Restart Codex after setting the account environment variable, then rerun this script."
}

if ([string]::IsNullOrWhiteSpace($Batch)) {
  $Batch = switch ("$Strategy/$CaseId") {
    "single-rag/mitt-wildcard" { "single-case-diagnostic-v17" }
    "single-rag/dlv-falsy-values" { "single-case-diagnostic-v18" }
    "single-rag/stringify-nonfinite" { "single-case-diagnostic-v19" }
    "single-rag/mitt-unknown-handler" { "single-case-diagnostic-v23" }
    "single-rag/stringify-array-holes" { "single-case-diagnostic-v24" }
    "single-rag/dlv-array-path" { "single-case-diagnostic-v25" }
    "single-no-rag/mitt-wildcard" { "single-case-diagnostic-v20" }
    "single-no-rag/dlv-falsy-values" { "single-case-diagnostic-v21" }
    "single-no-rag/stringify-nonfinite" { "single-case-diagnostic-v22" }
    "single-no-rag/mitt-unknown-handler" { "single-case-diagnostic-v26" }
    "single-no-rag/stringify-array-holes" { "single-case-diagnostic-v27" }
    "single-no-rag/dlv-array-path" { "single-case-diagnostic-v28" }
  }
}
if ($Batch -notmatch "^single-case-diagnostic-v[1-9][0-9]*$") {
  throw "Batch must look like single-case-diagnostic-v14"
}
if ($ContextWindow -notin @(4096, 8192, 32768, 262144)) {
  throw "ContextWindow must be 4096, 8192, 32768, or 262144"
}

$env:NEWAGENT_EVAL_DATASET_VERSION = "v2"
$env:NEWAGENT_EVAL_BATCH = $Batch
$env:NEWAGENT_EVAL_MODEL = "siliconflow-deepseek-flash"
$env:NEWAGENT_EVAL_TOOL_LIMIT = "24"
$env:NEWAGENT_EVAL_STRATEGY = $Strategy
$env:NEWAGENT_EVAL_TOP_P = "1"
$env:NEWAGENT_EVAL_CONTEXT_WINDOW = "$ContextWindow"
$env:NEWAGENT_EVAL_PRESENCE_PENALTY = "1.5"
$env:NODE_OPTIONS = "--use-system-ca --use-env-proxy"

npm run eval:local:single-case -- $CaseId
exit $LASTEXITCODE
