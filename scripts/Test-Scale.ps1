[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$TenantId,
    [ValidateSet('pilot', 'department', 'enterprise')][string]$Profile = 'pilot',
    [string]$OutputFile
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$stateDirectory = if ($env:SAM_INSTALL_STATE_DIR) { [IO.Path]::GetFullPath($env:SAM_INSTALL_STATE_DIR) } else { Join-Path $repoRoot '.install' }
$stateFile = Join-Path $stateDirectory "$TenantId.json"
if (-not (Test-Path -LiteralPath $stateFile)) { throw 'Install state not found.' }
$state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
$token = az account get-access-token --tenant $TenantId --scope "api://$($state.apiClientId)/user_impersonation" --query accessToken --output tsv
if ($LASTEXITCODE -ne 0 -or -not $token) { throw 'Could not obtain the delegated load-test token.' }
if (-not $OutputFile) { $OutputFile = Join-Path $repoRoot "artifacts\scale-$Profile-$((Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')).json" }
New-Item -ItemType Directory -Path (Split-Path -Parent $OutputFile) -Force | Out-Null
try {
    $env:SAM_ACCESS_TOKEN = $token
    node (Join-Path $PSScriptRoot 'load-test.mjs') "--url=$($state.appUrl)" "--profile=$Profile" "--output=$([IO.Path]::GetFullPath($OutputFile))"
    if ($LASTEXITCODE) { throw "The $Profile load profile failed its thresholds." }
} finally {
    Remove-Item Env:\SAM_ACCESS_TOKEN -ErrorAction SilentlyContinue
    $token = $null
}
Write-Output ([IO.Path]::GetFullPath($OutputFile))