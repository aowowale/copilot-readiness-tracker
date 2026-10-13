[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$TenantId,
    [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$stateFile = Join-Path $repoRoot ".install\$TenantId.json"
if (-not (Test-Path -LiteralPath $stateFile)) { throw 'Install state not found.' }
$state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repoRoot "artifacts\backups\$((Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss'))" }
$suffix = if ($state.cloud -eq 'AzureUSGovernment') { 'core.usgovcloudapi.net' } else { 'core.windows.net' }
$tableEndpoint = "https://$($state.storageAccount).table.$suffix"
$blobEndpoint = "https://$($state.storageAccount).blob.$suffix"
Push-Location (Join-Path $repoRoot 'backend')
try { node (Join-Path $repoRoot 'backend\src\tools\backup-restore.js') backup $tableEndpoint $blobEndpoint ([IO.Path]::GetFullPath($OutputDirectory)) } finally { Pop-Location }
if ($LASTEXITCODE) { throw 'Backup failed.' }
Write-Output ([IO.Path]::GetFullPath($OutputDirectory))