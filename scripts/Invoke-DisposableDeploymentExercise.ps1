<#
.SYNOPSIS
    Runs fresh deployment, rollback, backup, uninstall, reinstall, and restore in a disposable target.
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory)][string]$ConfigPath,
    [Parameter(Mandatory)][string]$PreviousReleaseZip,
    [Parameter(Mandatory)][string]$PreviousReleaseSha256,
    [Parameter(Mandatory)][ValidateSet('DELETE DISPOSABLE SAM DEPLOYMENT')][string]$DestructiveAcknowledgment,
    [string]$EvidenceDirectory = (Join-Path (Split-Path -Parent $PSScriptRoot) 'artifacts\disposable-exercise')
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
if ([string]$config.azure.resourceGroup -notmatch '^rg-sam-disposable-[a-z0-9-]+$') { throw 'Disposable exercise resourceGroup must start with rg-sam-disposable-.' }
$currentStates = @(Get-ChildItem (Join-Path $repoRoot '.install\*.json') -ErrorAction SilentlyContinue | ForEach-Object { Get-Content $_ -Raw | ConvertFrom-Json })
if ($currentStates.resourceGroup -contains [string]$config.azure.resourceGroup) { throw 'The target resource group belongs to an existing deployment. Choose a new disposable name.' }
if ($currentStates.functionApp -and [string]$config.azure.namePrefix -eq 'samgov') { throw 'Use a unique namePrefix for the disposable deployment.' }
New-Item -ItemType Directory -Path $EvidenceDirectory -Force | Out-Null
$transcript = Join-Path $EvidenceDirectory "exercise-$((Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')).log"
$previousStateDirectory = $env:SAM_INSTALL_STATE_DIR
$env:SAM_INSTALL_STATE_DIR = Join-Path ([IO.Path]::GetFullPath($EvidenceDirectory)) 'install-state'
Start-Transcript -Path $transcript | Out-Null
try {
    if (-not $PSCmdlet.ShouldProcess($config.azure.resourceGroup, 'Deploy, roll back, uninstall, reinstall, restore, and delete disposable deployment')) { return }
    & (Join-Path $PSScriptRoot 'Deploy-Customer.ps1') -ConfigPath $ConfigPath -PreflightOnly
    & (Join-Path $PSScriptRoot 'Deploy-Customer.ps1') -ConfigPath $ConfigPath
    & (Join-Path $PSScriptRoot 'Test-Deployment.ps1') -TenantId $config.azure.tenantId

    $preRollbackBackup = Join-Path $EvidenceDirectory 'pre-rollback-backup'
    & (Join-Path $PSScriptRoot 'Backup-Governance.ps1') -TenantId $config.azure.tenantId -OutputDirectory $preRollbackBackup | Out-Host
    & (Join-Path $PSScriptRoot 'Rollback-Governance.ps1') -ConfigPath $ConfigPath -PreviousReleaseZip $PreviousReleaseZip -PreviousReleaseSha256 $PreviousReleaseSha256 -BackupDirectory $preRollbackBackup -Confirm:$false
    & (Join-Path $PSScriptRoot 'Test-Deployment.ps1') -TenantId $config.azure.tenantId -SkipCollector

    & (Join-Path $PSScriptRoot 'Uninstall-Governance.ps1') -TenantId $config.azure.tenantId -PlanOnly | Set-Content (Join-Path $EvidenceDirectory 'uninstall-plan.json')
    $uninstallBackup = Join-Path $EvidenceDirectory 'uninstall-backup'
    & (Join-Path $PSScriptRoot 'Uninstall-Governance.ps1') -TenantId $config.azure.tenantId -BackupOutputDirectory $uninstallBackup -Confirm:$false
    if (az group exists --name $config.azure.resourceGroup --subscription $config.azure.subscriptionId | ConvertFrom-Json) { throw 'Disposable resource group still exists after uninstall.' }

    & (Join-Path $PSScriptRoot 'Deploy-Customer.ps1') -ConfigPath $ConfigPath
    & (Join-Path $PSScriptRoot 'Restore-Governance.ps1') -TenantId $config.azure.tenantId -BackupDirectory $uninstallBackup -Confirm:$false
    & (Join-Path $PSScriptRoot 'Test-Deployment.ps1') -TenantId $config.azure.tenantId -SkipCollector
    & (Join-Path $PSScriptRoot 'Uninstall-Governance.ps1') -TenantId $config.azure.tenantId -BackupOutputDirectory (Join-Path $EvidenceDirectory 'final-backup') -Confirm:$false
    [pscustomobject]@{ Passed = $true; EvidenceDirectory = [IO.Path]::GetFullPath($EvidenceDirectory); Transcript = $transcript }
} finally {
    Stop-Transcript -ErrorAction SilentlyContinue | Out-Null
    $env:SAM_INSTALL_STATE_DIR = $previousStateDirectory
}