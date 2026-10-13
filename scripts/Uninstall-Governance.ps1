[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory)][string]$TenantId,
    [switch]$PlanOnly,
    [switch]$SkipBackup,
    [string]$BackupOutputDirectory,
    [switch]$PreserveResourceGroup,
    [switch]$PurgeKeyVault
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$stateDirectory = if ($env:SAM_INSTALL_STATE_DIR) { [IO.Path]::GetFullPath($env:SAM_INSTALL_STATE_DIR) } else { Join-Path $repoRoot '.install' }
$stateFile = Join-Path $stateDirectory "$TenantId.json"
if (-not (Test-Path -LiteralPath $stateFile)) { throw 'Install state not found.' }
$state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
$plan = [ordered]@{
    tenantId = '<redacted>'
    backup = -not $SkipBackup
    deleteEntraApplication = $state.apiClientId
    deleteResourceGroup = -not $PreserveResourceGroup
    resourceGroup = $state.resourceGroup
    preserveInstallStateUntilSuccess = $true
    purgeKeyVault = [bool]$PurgeKeyVault
}
if ($PlanOnly) { $plan | ConvertTo-Json -Depth 4; return }
if (-not $SkipBackup) {
    $backupParameters = @{ TenantId = $TenantId }
    if ($BackupOutputDirectory) { $backupParameters.OutputDirectory = $BackupOutputDirectory }
    & (Join-Path $PSScriptRoot 'Backup-Governance.ps1') @backupParameters | Out-Host
}
if ($PSCmdlet.ShouldProcess($state.apiClientId, 'Delete governance Entra application and service principal')) {
    az ad app delete --id $state.apiClientId
    if ($LASTEXITCODE -ne 0) { throw 'Entra application deletion failed; Azure resources and install state were preserved.' }
}
if (-not $PreserveResourceGroup -and $PSCmdlet.ShouldProcess($state.resourceGroup, 'Delete dedicated Azure resource group and all contained resources')) {
    az group delete --name $state.resourceGroup --subscription $state.subscriptionId --yes
    if ($LASTEXITCODE -ne 0) { throw 'Resource group deletion failed; install state was preserved.' }
}
if ($PurgeKeyVault -and $state.keyVault -and $PSCmdlet.ShouldProcess($state.keyVault, 'Permanently purge the soft-deleted Key Vault')) {
    $location = az keyvault list-deleted --subscription $state.subscriptionId --query "[?name=='$($state.keyVault)'].properties.location | [0]" --output tsv
    if ($location) {
        az keyvault purge --name $state.keyVault --location $location --subscription $state.subscriptionId
        if ($LASTEXITCODE -ne 0) { throw 'Key Vault purge failed; install state was preserved.' }
    }
}
Remove-Item -LiteralPath $stateFile -Force
Write-Host 'Uninstall completed. The backup was retained outside the resource group.' -ForegroundColor Green