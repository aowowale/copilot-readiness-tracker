<#
.SYNOPSIS
    Deploys the read-only GCC High collector + API infrastructure and publishes the Functions app.

.DESCRIPTION
    Run from the customer's secure environment (AVD) after az login to Azure Government.
    This script does not grant Microsoft Graph application permissions; a customer Entra
    administrator must consent to them separately (see CUSTOMER-DEPLOYMENT.md).

.NOTES
    Requires: Azure CLI, Azure Functions Core Tools (func), Node.js 20+.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ResourceGroup,
    [Parameter(Mandatory = $true)][string]$Location,
    [Parameter(Mandatory = $true)][string]$ParametersFile,
    [switch]$SkipInfra
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$infraFile = Join-Path $repoRoot 'infra\main.bicep'
$backendDir = Join-Path $repoRoot 'backend'

Write-Host 'Confirming Azure Government context...' -ForegroundColor Cyan
$account = az account show --output json | ConvertFrom-Json
if (-not $account) { throw 'Run az login first.' }
if ($account.environmentName -ne 'AzureUSGovernment') {
    throw "Active cloud is '$($account.environmentName)'. Switch with: az cloud set --name AzureUSGovernment"
}
Write-Host "Subscription: $($account.name) ($($account.id))" -ForegroundColor Green

az group create --name $ResourceGroup --location $Location --output none

if (-not $SkipInfra) {
    Write-Host 'Deploying infrastructure...' -ForegroundColor Cyan
    $deployment = az deployment group create `
        --resource-group $ResourceGroup `
        --template-file $infraFile `
        --parameters "@$ParametersFile" `
        --output json | ConvertFrom-Json
    $outputs = $deployment.properties.outputs
} else {
    Write-Host 'Skipping infra; reading existing deployment outputs...' -ForegroundColor Yellow
    $deployment = az deployment group show --resource-group $ResourceGroup --name 'main' --output json | ConvertFrom-Json
    $outputs = $deployment.properties.outputs
}

$functionAppName = $outputs.functionAppName.value
$apiPath = $outputs.workspacesApiPath.value
$identityClientId = $outputs.collectorIdentityClientId.value

Write-Host "Publishing Functions app to $functionAppName..." -ForegroundColor Cyan
Push-Location $backendDir
try {
    npm install --omit=dev
    func azure functionapp publish $functionAppName --javascript
}
finally {
    Pop-Location
}

Write-Host '' 
Write-Host 'Deployment complete.' -ForegroundColor Green
Write-Host "Workspaces API: $apiPath"
Write-Host "Collector identity client ID: $identityClientId"
Write-Host ''
Write-Host 'Next steps (customer administrator):' -ForegroundColor Cyan
Write-Host '  1. Grant the collector identity the reviewed read-only Microsoft Graph application permissions and admin consent.'
Write-Host '  2. Configure App Service Authentication (Entra) on the Function app and restrict access to the governance group.'
Write-Host '  3. Set the dashboard data source to the Workspaces API URL above.'
