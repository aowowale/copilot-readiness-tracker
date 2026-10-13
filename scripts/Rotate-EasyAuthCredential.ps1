[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory)][string]$TenantId,
    [ValidateRange(30, 730)][int]$ValidityDays = 365,
    [switch]$SkipValidation
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$stateFile = Join-Path $repoRoot ".install\$TenantId.json"
if (-not (Test-Path -LiteralPath $stateFile)) { throw 'Install state not found.' }
$state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
if (-not $state.keyVault) { throw 'This deployment predates Key Vault-backed Easy Auth. Upgrade it before rotating.' }
if (-not $PSCmdlet.ShouldProcess($state.apiClientId, 'Rotate the Easy Auth credential and validate browser/API authentication')) { return }

$displayName = "sam-easyauth-$(Get-Date -Format yyyyMMdd-HHmmss)"
$expires = (Get-Date).ToUniversalTime().AddDays($ValidityDays).ToString('yyyy-MM-ddTHH:mm:ssZ')
$priorCredentials = @(az ad app credential list --id $state.apiClientId --output json | ConvertFrom-Json | Where-Object { $_.displayName -like 'sam-easyauth-*' -or $_.displayName -like 'install-*' })
$secret = (az ad app credential reset --id $state.apiClientId --append --display-name $displayName --end-date $expires --query password --output tsv)
if ($LASTEXITCODE -ne 0 -or -not $secret) { throw 'Failed to create replacement Entra credential.' }

try {
    az keyvault secret set --vault-name $state.keyVault --name easy-auth-client-secret --value $secret --expires $expires --output none
    if ($LASTEXITCODE -ne 0) { throw 'Failed to update the Key Vault secret.' }
    $siteId = az functionapp show --resource-group $state.resourceGroup --name $state.functionApp --subscription $state.subscriptionId --query id --output tsv
    az rest --method post --url "$siteId/config/configreferences/appsettings/refresh?api-version=2022-03-01" --output none
    if ($LASTEXITCODE -ne 0) { throw 'Failed to refresh App Service Key Vault references.' }
    if (-not $SkipValidation) { & (Join-Path $PSScriptRoot 'Test-Deployment.ps1') -TenantId $TenantId -SkipCollector }
    if ($LASTEXITCODE) { throw 'Post-rotation validation failed. Prior credentials were retained.' }
    foreach ($credential in $priorCredentials) {
        az ad app credential delete --id $state.apiClientId --key-id $credential.keyId
        if ($LASTEXITCODE -ne 0) { throw "Failed to remove superseded credential $($credential.keyId)." }
    }
} finally {
    $secret = $null
    [GC]::Collect()
}

Write-Host 'Easy Auth credential rotated, refreshed, validated, and superseded credentials removed.' -ForegroundColor Green