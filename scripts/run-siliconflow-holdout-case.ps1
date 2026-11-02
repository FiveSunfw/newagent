param(
  [Parameter(Mandatory = $true)]
  [ValidateSet(
    "mitt-dispatch-snapshot",
    "mitt-once-integration",
    "stringify-key-comparator",
    "stringify-cycle-recovery",
    "dlv-null-traversal",
    "dlv-options-integration"
  )]
  [string]$CaseId,
  [ValidateSet("single-no-rag", "single-rag", "adaptive-rag")]
  [string]$Strategy = "single-no-rag",
  [string]$Batch = "",
  [ValidateSet(262144)]
  [int]$ContextWindow = 262144
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($env:NEWAGENT_API_KEY)) {
  throw "NEWAGENT_API_KEY is not visible to this process. Restart Codex after setting the account environment variable, then rerun this script."
}

if ([string]::IsNullOrWhiteSpace($Batch)) {
  $caseOrder = @(
    "mitt-dispatch-snapshot",
    "mitt-once-integration",
    "stringify-key-comparator",
    "stringify-cycle-recovery",
    "dlv-null-traversal",
    "dlv-options-integration"
  )
  $strategyOrder = @("single-no-rag", "single-rag", "adaptive-rag")
  $caseIndex = [Array]::IndexOf($caseOrder, $CaseId)
  $strategyIndex = [Array]::IndexOf($strategyOrder, $Strategy)
  $batchNumber = $caseIndex * $strategyOrder.Count + $strategyIndex + 1
  $Batch = "single-case-holdout-diagnostic-v$batchNumber"
}
if ($Batch -notmatch "^single-case-holdout-diagnostic-v[1-9][0-9]*$") {
  throw "Batch must look like single-case-holdout-diagnostic-v1"
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

npm run eval:local:single-case-holdout -- $CaseId
exit $LASTEXITCODE
