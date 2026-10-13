<#
.SYNOPSIS
    Runs a fail-closed read-only customer pilot and writes sanitized acceptance evidence.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$TenantId,
    [string]$PilotName = 'read-only-pilot-2',
    [string]$OutputDirectory = (Join-Path (Split-Path -Parent $PSScriptRoot) 'artifacts')
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$stateDirectory = if ($env:SAM_INSTALL_STATE_DIR) { [IO.Path]::GetFullPath($env:SAM_INSTALL_STATE_DIR) } else { Join-Path $repoRoot '.install' }
$stateFile = Join-Path $stateDirectory "$TenantId.json"
if (-not (Test-Path -LiteralPath $stateFile)) { throw "No install record exists for the requested tenant." }
$state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json

$settings = az functionapp config appsettings list `
    --resource-group $state.resourceGroup `
    --name $state.functionApp `
    --subscription $state.subscriptionId `
    --output json 2>$null | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Unable to read Function App settings. Confirm the isolated Azure CLI profile and login.' }

function Setting([string]$Name) {
    [string](($settings | Where-Object name -eq $Name | Select-Object -First 1).value)
}

$executionMode = (Setting 'EXECUTION_MODE').ToLowerInvariant()
$lifecycleEnabled = (Setting 'ENABLE_LIFECYCLE_EXECUTION').ToLowerInvariant()
$notificationMode = (Setting 'NOTIFICATION_MODE').ToLowerInvariant()
$unsafe = @()
if ($executionMode -and $executionMode -ne 'dry-run') { $unsafe += "EXECUTION_MODE=$executionMode" }
if ($lifecycleEnabled -and $lifecycleEnabled -ne 'false') { $unsafe += "ENABLE_LIFECYCLE_EXECUTION=$lifecycleEnabled" }
if ($notificationMode -and $notificationMode -notin 'off', 'dry-run') { $unsafe += "NOTIFICATION_MODE=$notificationMode" }
if ($unsafe.Count) { throw "Read-only pilot refused because unsafe settings are enabled: $($unsafe -join ', ')" }

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$startedUtc = [DateTime]::UtcNow
$transcriptPath = Join-Path $OutputDirectory "$PilotName-validation.txt"
$reportPath = Join-Path $OutputDirectory "$PilotName-acceptance.json"

$output = & (Join-Path $PSScriptRoot 'Test-Deployment.ps1') -TenantId $TenantId -SkipCollector *>&1
$exitCode = $LASTEXITCODE
$sanitizedOutput = $output | Out-String
$identifiers = [ordered]@{
    $TenantId = '<tenant-id>'
    ([string]$state.subscriptionId) = '<subscription-id>'
    ([string]$state.resourceGroup) = '<resource-group>'
    ([string]$state.functionApp) = '<function-app>'
}
foreach ($entry in $identifiers.GetEnumerator()) {
    if ($entry.Key) { $sanitizedOutput = $sanitizedOutput -replace [regex]::Escape($entry.Key), $entry.Value }
}
$sanitizedOutput = $sanitizedOutput -replace 'https://[^\s/]+\.azurewebsites\.us', 'https://<function-app>.azurewebsites.us'
Set-Content -LiteralPath $transcriptPath -Value $sanitizedOutput.TrimEnd() -Encoding UTF8

$passCount = ([regex]::Matches($sanitizedOutput, '(?m)^PASS\s')).Count
$failCount = ([regex]::Matches($sanitizedOutput, '(?m)^FAIL\s')).Count
$report = [ordered]@{
    schemaVersion = 1
    pilotName = $PilotName
    startedUtc = $startedUtc.ToString('o')
    finishedUtc = [DateTime]::UtcNow.ToString('o')
    mode = 'read-only-dry-run'
    collectorTriggered = $false
    safetyGate = [ordered]@{
        executionMode = $(if ($executionMode) { $executionMode } else { 'unset-safe-default' })
        lifecycleExecution = $(if ($lifecycleEnabled) { $lifecycleEnabled } else { 'unset-safe-default' })
        notificationMode = $(if ($notificationMode) { $notificationMode } else { 'unset-safe-default' })
        passed = $true
    }
    validation = [ordered]@{
        exitCode = $exitCode
        passed = ($exitCode -eq 0 -and $failCount -eq 0)
        passCount = $passCount
        failCount = $failCount
        transcript = [IO.Path]::GetFileName($transcriptPath)
    }
    identifiers = 'Sanitized; no tenant, subscription, resource group, or Function App identifiers are recorded.'
}
$report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $reportPath -Encoding UTF8

Write-Output $sanitizedOutput.TrimEnd()
Write-Output "`nAcceptance report: $reportPath"
if ($exitCode -ne 0 -or $failCount) { exit 1 }