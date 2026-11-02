param([switch]$Recreate)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$newagentRoot = "E:\newagent"
$ragasVenv = Join-Path $newagentRoot "tools\ragas-venv"
$pipCache = Join-Path $newagentRoot "cache\pip-ragas"
$resolutionReport = Join-Path $newagentRoot "cache\ragas\pip-resolution.json"
$requirementsInput = Join-Path $PSScriptRoot "requirements.in"
$requirementsLock = Join-Path $PSScriptRoot "requirements.lock"
$lockGenerator = Join-Path $PSScriptRoot "lock_from_report.py"

$pythonCommand = Get-Command python -ErrorAction Stop
$pythonVersion = & $pythonCommand.Source --version
if ($pythonVersion -notmatch "^Python 3\.11\.") {
  throw "Python 3.11 is required; found $pythonVersion"
}

New-Item -ItemType Directory -Force -Path $pipCache, (Split-Path $resolutionReport) | Out-Null
$venvPython = Join-Path $ragasVenv "Scripts\python.exe"
if ($Recreate -and (Test-Path -LiteralPath $ragasVenv)) {
  & $pythonCommand.Source -m venv --clear $ragasVenv
  if ($LASTEXITCODE -ne 0) { throw "Failed to recreate the Ragas virtual environment" }
} elseif (-not (Test-Path -LiteralPath $venvPython)) {
  & $pythonCommand.Source -m venv $ragasVenv
  if ($LASTEXITCODE -ne 0) { throw "Failed to create the Ragas virtual environment" }
}

$env:PIP_CACHE_DIR = $pipCache
& $venvPython -m pip install --disable-pip-version-check --dry-run --ignore-installed --report $resolutionReport -r $requirementsInput
if ($LASTEXITCODE -ne 0) { throw "Could not resolve Ragas dependencies; no model calls were made" }

& $venvPython $lockGenerator $resolutionReport $requirementsLock
if ($LASTEXITCODE -ne 0) { throw "Could not write the dependency lock file" }

& $venvPython -m pip install --disable-pip-version-check --require-hashes -r $requirementsLock
if ($LASTEXITCODE -ne 0) { throw "Could not install the hash-locked Ragas dependencies" }

& $venvPython -m pip check
if ($LASTEXITCODE -ne 0) { throw "The Ragas virtual environment has incompatible dependencies; try -Recreate" }

& $venvPython -c "import ragas, sys; print('Python', sys.version.split()[0], 'Ragas', ragas.__version__)"
if ($LASTEXITCODE -ne 0) { throw "Ragas installation did not pass its import check" }
