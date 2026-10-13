<#
.SYNOPSIS
    Performs non-mutating readiness checks for optional production capabilities.

.DESCRIPTION
    Compares live executor Graph grants with the feature-specific permission set, checks deployed
    settings and source health, and optionally verifies the Exchange Mail.Send allow/deny boundary.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$TenantId,
    [string]$ApprovedSender,
    [string]$DeniedMailbox,
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$stateDirectory = if ($env:SAM_INSTALL_STATE_DIR) { [IO.Path]::GetFullPath($env:SAM_INSTALL_STATE_DIR) } else { Join-Path $repoRoot '.install' }
$stateFile = Join-Path $stateDirectory "$TenantId.json"
if (-not (Test-Path -LiteralPath $stateFile)) { throw 'Install state not found.' }
$state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
$checks = [System.Collections.Generic.List[object]]::new()
function Add-Check([string]$Name, [bool]$Passed, [string]$Detail) {
    $checks.Add([pscustomobject]@{ name = $Name; passed = $Passed; detail = $Detail })
    Write-Host ('{0,-4} {1} ({2})' -f $(if ($Passed) { 'PASS' } else { 'FAIL' }), $Name, $Detail)
}

$settings = @(az functionapp config appsettings list --resource-group $state.resourceGroup --name $state.functionApp --subscription $state.subscriptionId --output json | ConvertFrom-Json)
if ($LASTEXITCODE) { throw 'Could not read deployed Function App settings.' }
function Setting([string]$Name) { [string]($settings | Where-Object name -eq $Name | Select-Object -First 1).value }

Add-Check 'Execution posture matches install state' ((Setting 'EXECUTION_MODE') -eq $(if ($state.executionEnabled) { $state.executionMode } else { 'dry-run' })) (Setting 'EXECUTION_MODE')
Add-Check 'Lifecycle flag matches install state' (((Setting 'ENABLE_LIFECYCLE_EXECUTION') -eq 'true') -eq [bool]$state.lifecycleExecutionEnabled) (Setting 'ENABLE_LIFECYCLE_EXECUTION')
Add-Check 'OneDrive revocation flag matches install state' (((Setting 'ENABLE_ONEDRIVE_SHARING_REVOCATION') -eq 'true') -eq [bool]$state.oneDriveSharingRevocationEnabled) (Setting 'ENABLE_ONEDRIVE_SHARING_REVOCATION')
if ($state.sensitivityLabelsEnabled) {
    $labelMap = Setting 'SENSITIVITY_LABEL_IDS' | ConvertFrom-Json -AsHashtable
    Add-Check 'Sensitivity-label map is deployed' ($labelMap.Count -gt 0) "$($labelMap.Count) mapped labels"
}

if ($state.executionEnabled) {
    Add-Check 'Executor identity is recorded' ([bool]$state.executorIdentityPrincipalId) 'separate managed identity'
    $graphRoot = (az cloud show --query endpoints.microsoftGraphResourceId --output tsv).TrimEnd('/')
    $graphService = az rest --method GET --url "$graphRoot/v1.0/servicePrincipals?`$filter=appId%20eq%20'00000003-0000-0000-c000-000000000000'&`$select=id,appRoles" --output json | ConvertFrom-Json
    $assignments = az rest --method GET --url "$graphRoot/v1.0/servicePrincipals/$($state.executorIdentityPrincipalId)/appRoleAssignments?`$select=appRoleId,resourceId" --output json | ConvertFrom-Json
    if ($LASTEXITCODE) { throw 'Could not read live executor Graph permission assignments.' }
    $roleById = @{}
    foreach ($role in $graphService.value[0].appRoles) { $roleById["$($role.id)"] = $role.value }
    $actual = @($assignments.value | Where-Object resourceId -eq $graphService.value[0].id | ForEach-Object { $roleById["$($_.appRoleId)"] } | Sort-Object -Unique)
    $expected = @($state.executorPermissionsGranted | Sort-Object -Unique)
    $missing = @($expected | Where-Object { $_ -notin $actual })
    $unexpected = @($actual | Where-Object { $_ -notin $expected })
    Add-Check 'Executor Graph grants match enabled features' (-not $missing.Count -and -not $unexpected.Count) "expected=$($expected -join ','); missing=$($missing -join ','); unexpected=$($unexpected -join ',')"
}

$token = az account get-access-token --tenant $TenantId --scope "api://$($state.apiClientId)/user_impersonation" --query accessToken --output tsv
if ($LASTEXITCODE -or -not $token) { throw 'Could not acquire governance API token.' }
$sources = Invoke-RestMethod -Uri "$($state.appUrl.TrimEnd('/'))/api/sources" -Headers @{ Authorization = "Bearer $token" }
foreach ($sourceName in 'graph-teams', 'evidence-feed', 'copilot-licences', 'copilot-usage', 'agent-inventory') {
    $source = @($sources.sources | Where-Object source -eq $sourceName | Sort-Object finishedAt -Descending)[0]
    $healthy = [bool]$source -and $source.status -in 'ok', 'partial', 'skipped'
    $detail = if ($sourceName -eq 'copilot-usage' -and $state.cloud -eq 'AzureUSGovernment' -and -not $healthy) {
        'Microsoft Graph Copilot usage reports are unavailable in US Government L4/L5; upload a fresh customer-approved Admin Center export in evidence.json.'
    } elseif ($source) { "$($source.status): $($source.error ?? ($source.warnings -join ' '))" } else { 'not recorded' }
    Add-Check "Source $sourceName is observable" $healthy $detail
}

if ($state.notificationMode -eq 'live') {
    if (-not $ApprovedSender -or -not $DeniedMailbox) { Add-Check 'Mail.Send boundary supplied for validation' $false 'use -ApprovedSender and -DeniedMailbox' }
    elseif (-not (Get-Command Test-ApplicationAccessPolicy -ErrorAction SilentlyContinue)) { Add-Check 'Exchange policy cmdlets available' $false 'connect ExchangeOnlineManagement first' }
    else {
        $executorClientId = Setting 'EXECUTOR_CLIENT_ID'
        $allow = Test-ApplicationAccessPolicy -Identity $ApprovedSender -AppId $executorClientId
        $deny = Test-ApplicationAccessPolicy -Identity $DeniedMailbox -AppId $executorClientId
        Add-Check 'Approved notification sender is allowed' ($allow.AccessCheckResult -eq 'Granted') $allow.AccessCheckResult
        Add-Check 'Out-of-scope mailbox is denied' ($deny.AccessCheckResult -eq 'Denied') $deny.AccessCheckResult
    }
}

$report = [ordered]@{ generatedAt = (Get-Date).ToUniversalTime().ToString('o'); tenantId = '<redacted>'; functionApp = $state.functionApp; checks = @($checks); passed = -not @($checks | Where-Object { -not $_.passed }).Count }
if ($OutputPath) { $report | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $OutputPath -Encoding utf8 }
$report | ConvertTo-Json -Depth 6
if (-not $report.passed) { exit 1 }