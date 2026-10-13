[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
    [Parameter(Mandatory)][string]$TenantId,
    [Parameter(Mandatory)][string]$BackupDirectory
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$stateFile = Join-Path $repoRoot ".install\$TenantId.json"
if (-not (Test-Path -LiteralPath $stateFile)) { throw 'Install state not found.' }
if (-not (Test-Path -LiteralPath (Join-Path $BackupDirectory 'backup-manifest.json'))) { throw 'Backup manifest not found.' }
$state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
if (-not $PSCmdlet.ShouldProcess($state.storageAccount, "Restore tables and blobs from $BackupDirectory")) { return }
$suffix = if ($state.cloud -eq 'AzureUSGovernment') { 'core.usgovcloudapi.net' } else { 'core.windows.net' }
Push-Location (Join-Path $repoRoot 'backend')
try { node (Join-Path $repoRoot 'backend\src\tools\backup-restore.js') restore "https://$($state.storageAccount).table.$suffix" "https://$($state.storageAccount).blob.$suffix" ([IO.Path]::GetFullPath($BackupDirectory)) } finally { Pop-Location }
if ($LASTEXITCODE) { throw 'Restore failed.' }